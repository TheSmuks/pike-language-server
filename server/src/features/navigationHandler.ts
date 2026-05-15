/**
 * Navigation and feature handlers — definition, references, rename,
 * document highlight, document symbol, semantic tokens, folding range,
 * signature help, code action, workspace symbol, completion, and save.
 *
 * Extracted from server.ts to keep the server entry point under 500 lines.
 */

import {
  type Connection,
  type CancellationToken,
  type Location as LspLocation,
  type DocumentHighlight,
  type Position,
  DocumentHighlightKind,
  ResponseError,
  ErrorCodes,
} from "vscode-languageserver/node";
// LSP extended error codes for the Language Server Protocol extension range.
import { LSPErrorCodes } from "vscode-languageserver-protocol/lib/common/api";
import type { TextDocuments } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Node as TsNode } from "web-tree-sitter";
import { parse } from "../parser";
import { getDocumentSymbols } from "./documentSymbol";
import { getParseDiagnostics } from "./diagnostics";
import {
  getDefinitionAt,
  getReferencesTo,
  type SymbolTable,
} from "./symbolTable";
import { getCompletions, type CompletionContext } from "./completion";
import { findIdentifierPrefixRange } from "./completionTrigger";
import type { WorkspaceIndex } from "./workspaceIndex";
import { findImplementations } from "./implementation";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { uriToPath } from "../util/uri";
import { pathToFileURL } from "node:url";
import { produceSemanticTokens, deltaEncodeTokens } from "./semanticTokens";
import { produceFoldingRanges } from "./foldingRange";
import { produceSignatureHelp } from "./signatureHelp";
import { produceInlayHints } from "./inlayHints";
import { produceCodeActions } from "./codeAction";
import { produceAutodocTemplateActions } from "./autodocTemplate";
import { produceGetterSetterActions } from "./getterSetter";
import { searchWorkspaceSymbols } from "./workspaceSymbol";
import { registerDocumentLinkHandler } from "./documentLink";
import { getSelectionRange } from "./selectionRange";
import {
  prepareCallHierarchy,
  getIncomingCalls,
  getOutgoingCalls,
} from "./callHierarchy";
import { produceCodeLenses } from "./codeLens";
import {
  resolveAccessDefinition,
  type ResolutionContext,
} from "./accessResolver";
import {
  getRenameLocations,
  buildWorkspaceEdit,
  prepareRename,
  validateRenameName,
} from "./rename";
import type { PikeWorker } from "./pikeWorker";
import type { LRUCache } from "../util/lruCache";
import type { DiagnosticManager } from "./diagnosticManager";
import { computeContentHash } from "./diagnosticManager";
import { logError, logWarn, ErrorCategory } from "../util/errorLog.js";
import stdlibAutodocIndex from "../data/stdlib-autodoc.json";
import predefBuiltinIndex from "../data/predef-builtin-index.json";

// ---------------------------------------------------------------------------
// Protected names (rename guard)
// ---------------------------------------------------------------------------

const predefBuiltins: Record<string, string> =
  predefBuiltinIndex as Record<string, string>;

/**
 * Build the set of protected symbol names that cannot be renamed.
 * Combines predef builtins (283) and unqualified stdlib names (5,471 FQNs).
 */
function buildProtectedNames(
  stdlibAutodoc: Record<string, unknown>,
  predef: Record<string, string>,
): Set<string> {
  const names = new Set<string>();
  // Predef builtins: keys are short names (write, search, etc.)
  for (const name of Object.keys(predef)) {
    names.add(name);
  }
  // Stdlib: keys are FQNs (predef.Array.diff). Extract unqualified name.
  for (const fqn of Object.keys(stdlibAutodoc)) {
    const parts = fqn.split(".");
    const short = parts[parts.length - 1];
    names.add(short);
  }
  return names;
}

const protectedNames: Set<string> = buildProtectedNames(
  stdlibAutodocIndex as Record<string, unknown>,
  predefBuiltins,
);

/**
 * Extract top-level stdlib module names from the autodoc index.
 * Keys are 'predef.Module.Class.method' — we extract the 'Module' segment.
 */
function buildStdlibModules(
  stdlibAutodoc: Record<string, unknown>,
): Set<string> {
  const modules = new Set<string>();
  for (const fqn of Object.keys(stdlibAutodoc)) {
    const parts = fqn.split(".");
    // predef.X.Y... → X is the module name
    if (parts.length >= 2) {
      modules.add(parts[1]);
    }
  }
  return modules;
}

const stdlibModules: Set<string> = buildStdlibModules(
  stdlibAutodocIndex as Record<string, unknown>,
);

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface NavigationContext {
  documents: TextDocuments<TextDocument>;
  index: WorkspaceIndex;
  worker: PikeWorker;
  getSymbolTable(uri: string): Promise<SymbolTable | null>;
  autodocCache: LRUCache<{ xml: string; hash: string; timestamp: number }>;
  diagnosticManager: DiagnosticManager;
  stdlibIndex: Record<string, { signature: string; markdown: string }>;
  predefBuiltins: Record<string, string>;
  /** Connection for logging when content is unexpectedly null. */
  connection: Connection;
}

// ---------------------------------------------------------------------------
// #include resolution
// ---------------------------------------------------------------------------

/**
 * If the cursor is on a `preproc_include` node, resolve the target file
 * and return an LSP Location for navigation (CTRL+CLICK on #include).
 *
 * tree-sitter-pike provides a structured `preproc_include` node with a
 * `path` field containing either `string_literal` or `system_lib_string`.
 *
 * For `"..."` includes: resolve relative to current file directory.
 * For `<...>` includes: search Pike's include paths (from `pike --show-paths`).
 */
function resolveIncludeTarget(
  doc: TextDocument,
  uri: string,
  line: number,
  character: number,
  includePaths: string[],
  workspaceRoot: string,
): LspLocation | null {
  const tree = parse(doc.getText(), uri);
  if (!tree?.rootNode) return null;

  const node = findNodeAtPosition(tree.rootNode, line, character);
  if (!node) return null;

  // findNodeAtPosition returns the deepest node. We want preproc_include
  // OR a direct child of preproc_include (e.g. system_lib_string when
  // clicking inside <stdio.h>). Walk up to find the include directive.
  let includeNode: TsNode | null = node;
  if (node.type !== "preproc_include") {
    includeNode = node.parent;
    while (includeNode && includeNode.type !== "preproc_include") {
      includeNode = includeNode.parent;
    }
  }
  if (!includeNode || includeNode.type !== "preproc_include") return null;

  const pathNode = includeNode.childForFieldName("path");
  if (!pathNode) return null;

  if (pathNode.type === "system_lib_string") {
    // Angle-bracket include: strip < and > from the text, then search
    // Pike's include directories.
    const pathText = pathNode.text.replace(/^<|>$/g, "");
    if (pathText.length === 0) return null;
    return resolveIncludeInSearchPaths(pathText, includePaths);
  }

  // String literal include: resolve relative to current file directory.
  const pathText = pathNode.text.replace(/^["]+|["]+$/g, "");
  if (pathText.length === 0) return null;

  const currentPath = uriToPath(uri);
  const currentDir = currentPath.substring(0, currentPath.lastIndexOf("/"));
  const targetPath = resolveRelativeIncludePath(pathText, currentDir, workspaceRoot);
  if (!targetPath) return null;

  return {
    uri: pathToFileURL(targetPath).href,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
  };
}

/**
 * Search include directories for a system header file.
 * Returns an LSP Location if the file exists, null otherwise.
 */
function resolveIncludeInSearchPaths(
  pathText: string,
  includePaths: string[],
): LspLocation | null {
  for (const dir of includePaths) {
    const candidate = join(dir, pathText);
    if (existsSync(candidate)) {
      return {
        uri: pathToFileURL(candidate).href,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      };
    }
  }
  return null;
}

/**
 * Walk the tree to find the deepest node at a given position.
 */
function findNodeAtPosition(
  node: TsNode,
  line: number,
  character: number,
): TsNode | null {
  if (
    line < node.startPosition.row ||
    line > node.endPosition.row
  ) return null;
  if (
    line === node.startPosition.row && character < node.startPosition.column
  ) return null;
  if (
    line === node.endPosition.row && character > node.endPosition.column
  ) return null;

  for (const child of node.children) {
    const found = findNodeAtPosition(child, line, character);
    if (found) return found;
  }

  return node;
}

/**
 * Resolve a relative include path against a base directory.
 * Handles `../`, `./`, and bare filenames.
 */
function resolveRelativeIncludePath(
  rawPath: string,
  baseDir: string,
  workspaceRoot: string,
): string | null {
  const cleanPath = rawPath.replace(/^["]+|["]+$/g, "");
  if (cleanPath.length === 0) return null;

  let targetPath: string;
  if (cleanPath.startsWith("../")) {
    let upCount = 0;
    let remaining = cleanPath;
    while (remaining.startsWith("../")) {
      upCount++;
      remaining = remaining.substring(3);
    }
    const parts = baseDir.split("/");
    if (upCount >= parts.length) return null;
    targetPath = parts.slice(0, -upCount).join("/") + "/" + remaining;
  } else if (cleanPath.startsWith("./")) {
    targetPath = baseDir + "/" + cleanPath.substring(2);
  } else {
    targetPath = baseDir + "/" + cleanPath;
  }

  // Security: reject paths that escaped the workspace.
  const normalized = resolve(targetPath);
  if (!normalized.startsWith(workspaceRoot)) return null;

  return normalized;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register all navigation and feature handlers on the connection.
 */
export function registerNavigationHandlers(
  connection: Connection,
  ctx: NavigationContext,
): void {
  const resolutionCtx: ResolutionContext = {
    documents: ctx.documents,
    index: ctx.index,
    stdlibIndex: ctx.stdlibIndex,
  };

  /** Build a source-aware type inferrer using PikeWorker.typeof_(). */
  const makeTypeInferrer = (source: string): ((varName: string) => Promise<string | null>) => {
    return async (varName: string) => {
      try {
        const result = await ctx.worker.typeof_(source, varName);
        if (result.type && !result.error) return result.type;
      } catch {
        // Worker unavailable — fall through
      }
      return null;
    };
  };
  const completionCtx = {
    index: ctx.index,
    stdlibIndex: ctx.stdlibIndex,
    predefBuiltins: ctx.predefBuiltins,
  };

  // -----------------------------------------------------------------------
  // documentSymbol
  // -----------------------------------------------------------------------

  connection.onDocumentSymbol(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return [];
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return [];

    try {
      const tree = parse(doc.getText(), doc.uri);

      // Return partial symbols — never crash on parse errors.
      // Note: parse diagnostics are handled by the diagnostic manager on didChange.
      return getDocumentSymbols(tree);
    } catch (err) {
      logError(connection, ErrorCategory.Parse, "navigationHandler.handleDocumentSymbol", err);
      return [];
    }
  });

  // -----------------------------------------------------------------------
  // textDocument/selectionRange — shrink/expand selection
  // -----------------------------------------------------------------------

  connection.onRequest(
    "textDocument/selectionRange",
    async (params, token: CancellationToken) => {
      if (token.isCancellationRequested) return null;
      const doc = ctx.documents.get(params.textDocument.uri);
      if (!doc) return null;

      // selectionRange supports multiple positions; handle each
      const results = [];
      for (const pos of params.positions) {
        if (token.isCancellationRequested) return results;
        const tree = parse(doc.getText(), doc.uri);
        const range = getSelectionRange(tree, pos.line, pos.character);
        results.push(range);
      }
      return results;
    },
  );

  // -----------------------------------------------------------------------
  // textDocument/semanticTokens/full
  // -----------------------------------------------------------------------

  connection.onRequest(
    "textDocument/semanticTokens/full",
    async (params, token: CancellationToken) => {
      if (token.isCancellationRequested) return { data: [] };
      const doc = ctx.documents.get(params.textDocument.uri);
      if (!doc) return { data: [] };

      const table = await ctx.getSymbolTable(params.textDocument.uri);
      if (!table) return { data: [] };

      const tokens = produceSemanticTokens(table);
      const data = deltaEncodeTokens(tokens);

      return { data };
    },
  );

  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // textDocument/diagnostic (pull diagnostics — diagnosticProvider capability)
  // -----------------------------------------------------------------------

  connection.onRequest(
    "textDocument/diagnostic",
    async (params: { textDocument: { uri: string } }, token: CancellationToken) => {
      if (token.isCancellationRequested) return { kind: "full", items: [] };
      const doc = ctx.documents.get(params.textDocument.uri);
      if (!doc) return { kind: "full", items: [] };

      try {
        const tree = parse(doc.getText(), params.textDocument.uri);
        const diagnostics = getParseDiagnostics(tree);
        return { kind: "full", items: diagnostics };
      } catch (err) {
        logError(connection, ErrorCategory.Diagnostics, "navigationHandler.handleDiagnostics", err);
        return { kind: "full", items: [] };
      }
    },
  );


  // -----------------------------------------------------------------------
  // textDocument/documentHighlight (US-015)
  // -----------------------------------------------------------------------

  connection.onDocumentHighlight(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return null;
    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table || token.isCancellationRequested) return null;

    const refs = getReferencesTo(
      table,
      params.position.line,
      params.position.character,
    );

    if (refs.length === 0) return null;

    // Map references to DocumentHighlight
    // Declaration sites → Write, reference sites → Read
    // Find the target declaration to distinguish
    const targetDecl = getDefinitionAt(
      table,
      params.position.line,
      params.position.character,
    );

    const highlights: DocumentHighlight[] = [];

    // Add the declaration itself as a Write highlight
    if (targetDecl) {
      highlights.push({
        range: {
          start: {
            line: targetDecl.nameRange.start.line,
            character: targetDecl.nameRange.start.character,
          },
          end: {
            line: targetDecl.nameRange.end.line,
            character: targetDecl.nameRange.end.character,
          },
        },
        kind: DocumentHighlightKind.Write,
      });
    }

    // Add all references as Read highlights
    for (const ref of refs) {
      // Skip if same position as declaration (already added as Write)
      if (
        targetDecl &&
        ref.loc.line === targetDecl.nameRange.start.line &&
        ref.loc.character === targetDecl.nameRange.start.character
      ) {
        continue;
      }

      highlights.push({
        range: {
          start: { line: ref.loc.line, character: ref.loc.character },
          end: {
            line: ref.loc.line,
            character: ref.loc.character + ref.name.length,
          },
        },
        kind: DocumentHighlightKind.Read,
      });
    }

    return highlights.length > 0 ? highlights : null;
  });

  // -----------------------------------------------------------------------
  // textDocument/foldingRange (US-016)
  // -----------------------------------------------------------------------

  connection.onRequest("textDocument/foldingRange", async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return [];
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return [];

    const tree = parse(doc.getText(), doc.uri);
    if (!tree) return [];

    return produceFoldingRanges(tree);
  });

  // -----------------------------------------------------------------------
  // textDocument/signatureHelp (US-017)
  // -----------------------------------------------------------------------

  connection.onRequest("textDocument/signatureHelp", async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return null;
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return null;

    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table || token.isCancellationRequested) return null;

    const tree = parse(doc.getText(), doc.uri);
    if (!tree) return null;

    return produceSignatureHelp(
      tree,
      table,
      params.position.line,
      params.position.character,
      ctx.stdlibIndex,
      {
        table,
        uri: params.textDocument.uri,
        index: ctx.index,
        stdlibIndex: ctx.stdlibIndex,
        typeInferrer: ctx.worker
          ? async (varName: string) => {
              try {
                const result = await ctx.worker.typeof_(doc.uri, varName);
                return result.type ?? null;
              } catch {
                return null;
              }
            }
          : undefined,
      },
    );
  });

  // -----------------------------------------------------------------------
  // textDocument/inlayHint (G1)
  // -----------------------------------------------------------------------

  connection.onRequest(
    "textDocument/inlayHint",
    async (params: { textDocument: { uri: string }; range: { start: Position; end: Position } }, token: CancellationToken) => {
      if (token.isCancellationRequested) return [];

      const doc = ctx.documents.get(params.textDocument.uri);
      if (!doc) return [];

      const table = await ctx.getSymbolTable(params.textDocument.uri);
      if (!table || token.isCancellationRequested) return [];

      const tree = parse(doc.getText(), doc.uri);
      if (!tree) return [];

      return produceInlayHints({
        tree,
        table,
        range: params.range,
      });
    },
  );

  // -----------------------------------------------------------------------
  // textDocument/codeAction (US-018)
  // -----------------------------------------------------------------------

  connection.onCodeAction(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return [];
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return [];

    const text = doc.getText();
    const diagnosticActions = produceCodeActions(params, text, { stdlibModules });
    const autodocActions = produceAutodocTemplateActions(params, text);
    const getterSetterActions = produceGetterSetterActions(params, text, { stdlibModules });
    return [...diagnosticActions, ...autodocActions, ...getterSetterActions];
  });

  // -----------------------------------------------------------------------
  // workspace/symbol (US-020)
  // -----------------------------------------------------------------------

  connection.onRequest("workspace/symbol", async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return [];
    const query = params.query ?? "";
    return searchWorkspaceSymbols(query, ctx.index);
  });

  // -----------------------------------------------------------------------
  // textDocument/definition
  // -----------------------------------------------------------------------

  connection.onDefinition(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return null;

    // Fast path: #include directive click-to-navigate.
    // #include is a preprocessor directive that won't appear in the symbol
    // table. Check the tree-sitter AST directly for a preprocessor_directive
    // node at the cursor position.
    const includeDoc = ctx.documents.get(params.textDocument.uri);
    if (includeDoc) {
      const includeResult = resolveIncludeTarget(
        includeDoc,
        params.textDocument.uri,
        params.position.line,
        params.position.character,
        ctx.index.pikePaths.includePaths,
        ctx.index.workspaceRoot,
      );
      if (includeResult) return includeResult;
    }

    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    // Try same-file resolution first
    const decl = getDefinitionAt(
      table,
      params.position.line,
      params.position.character,
    );

    if (decl) {
      // If the cursor is directly on the declaration's own name, the user
      // is CTRL+CLICKing the definition itself. Return all references as
      // multiple Locations so VSCode shows a peek list (usages).
      const nr = decl.nameRange;
      const cursorOnDeclName = nr.start.line === params.position.line &&
        params.position.character >= nr.start.character &&
        params.position.character <= nr.end.character;

      if (cursorOnDeclName && decl.kind !== "inherit" && decl.kind !== "import") {
        const refs = getReferencesTo(table, params.position.line, params.position.character);
        if (refs.length > 0) {
          return refs.map(ref => ({
            uri: table.uri,
            range: {
              start: { line: ref.loc.line, character: ref.loc.character },
              end: { line: ref.loc.line, character: ref.loc.character + ref.name.length },
            },
          }));
        }
      }

      // Synthetic declarations from cross-file inheritance carry sourceUri
      // pointing to the original file. Use that for navigation so CTRL+CLICK
      // on an imported/inherited symbol jumps to the source definition.
      const targetUri = decl.sourceUri ?? table.uri;
      const loc: LspLocation = {
        uri: targetUri,
        range: {
          start: {
            line: decl.nameRange.start.line,
            character: decl.nameRange.start.character,
          },
          end: {
            line: decl.nameRange.end.line,
            character: decl.nameRange.end.character,
          },
        },
      };
      return loc;
    }

    // Try cross-file resolution
    const crossFile = await ctx.index.resolveCrossFileDefinition(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    );

    if (crossFile) {
      if (token.isCancellationRequested) return null;
      const loc: LspLocation = {
        uri: crossFile.uri,
        range: {
          start: {
            line: crossFile.decl.nameRange.start.line,
            character: crossFile.decl.nameRange.start.character,
          },
          end: {
            line: crossFile.decl.nameRange.end.line,
            character: crossFile.decl.nameRange.end.character,
          },
        },
      };
      return loc;
    }
    // Try arrow/dot access resolution (obj->member, Module.function)
    const doc = ctx.documents.get(params.textDocument.uri);
    const accessTree = doc
      ? parse(doc.getText(), params.textDocument.uri)
      : undefined;
    const accessResolutionCtx: ResolutionContext = doc
      ? { ...resolutionCtx, typeInferrer: makeTypeInferrer(doc.getText()) }
      : resolutionCtx;
    const accessResult = await resolveAccessDefinition(
      accessResolutionCtx,
      table,
      params.textDocument.uri,
      params.position.line,
      params.position.character,
      accessTree,
    );

    return accessResult;
  });

  // -----------------------------------------------------------------------
  // textDocument/references
  // -----------------------------------------------------------------------

  connection.onReferences(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return [];
    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table) return [];

    const includeDeclaration = params.context?.includeDeclaration === true;

    // Try cross-file references
    const crossFileRefs = ctx.index.getCrossFileReferences(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    );

    if (crossFileRefs.length > 0) {
      let results = crossFileRefs.map(({ uri, ref }) => ({
        uri,
        range: {
          start: { line: ref.loc.line, character: ref.loc.character },
          end: {
            line: ref.loc.line,
            character: ref.loc.character + ref.name.length,
          },
        },
      }));

      if (includeDeclaration) {
        const decl = getDefinitionAt(
          table,
          params.position.line,
          params.position.character,
        );
        if (decl) {
          const declLoc = {
            uri: table.uri,
            range: {
              start: {
                line: decl.nameRange.start.line,
                character: decl.nameRange.start.character,
              },
              end: {
                line: decl.nameRange.end.line,
                character: decl.nameRange.end.character,
              },
            },
          };
          // Avoid duplicates when cursor is already on a reference
          const isDuplicate = results.some(
            r =>
              r.range.start.line === declLoc.range.start.line &&
              r.range.start.character === declLoc.range.start.character,
          );
          if (!isDuplicate) results.unshift(declLoc);
        }
      }

      return results;
    }

    // Fallback to same-file references
    const refs = getReferencesTo(
      table,
      params.position.line,
      params.position.character,
    );

    let results = refs.map(ref => ({
      uri: table.uri,
      range: {
        start: { line: ref.loc.line, character: ref.loc.character },
        end: {
          line: ref.loc.line,
          character: ref.loc.character + ref.name.length,
        },
      },
    }));

    if (includeDeclaration) {
      const decl = getDefinitionAt(
        table,
        params.position.line,
        params.position.character,
      );
      if (decl) {
        const declLoc = {
          uri: table.uri,
          range: {
            start: {
              line: decl.nameRange.start.line,
              character: decl.nameRange.start.character,
            },
            end: {
              line: decl.nameRange.end.line,
              character: decl.nameRange.end.character,
            },
          },
        };
        const isDuplicate = results.some(
          r =>
            r.range.start.line === declLoc.range.start.line &&
            r.range.start.character === declLoc.range.start.character,
        );
        if (!isDuplicate) results.unshift(declLoc);
      }
    }

    return results;
  });

  // -----------------------------------------------------------------------
  // textDocument/implementation
  // -----------------------------------------------------------------------

  connection.onRequest(
    "textDocument/implementation",
    async (params, token: CancellationToken) => {
      if (token.isCancellationRequested) return [];

      const impls = findImplementations(
        ctx.index,
        params.textDocument.uri,
        params.position.line,
        params.position.character,
      );

      return impls.map((impl) => ({
        uri: impl.uri,
        range: impl.range,
      }));
    },
  );

  // -----------------------------------------------------------------------
  // textDocument/rename (decision 0016)
  // -----------------------------------------------------------------------

  connection.onPrepareRename(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return null;
    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    const result = prepareRename(
      table,
      params.position.line,
      params.position.character,
      protectedNames,
    );
    if (!result) return null;

    return {
      range: {
        start: {
          line: result.line,
          character: result.character,
        },
        end: {
          line: result.line,
          character: result.character + result.length,
        },
      },
      placeholder: result.name,
    };
  });

  connection.onRenameRequest(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return null;
    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    // Validate new name — return a descriptive error, not silent null.
    const validationError = validateRenameName(params.newName);
    if (validationError) {
      return new ResponseError(ErrorCodes.InvalidRequest, validationError);
    }

    const renameResult = await getRenameLocations(
      table,
      params.textDocument.uri,
      params.position.line,
      params.position.character,
      ctx.index,
      protectedNames,
    );

    if (!renameResult) {
      return new ResponseError(
        ErrorCodes.InvalidRequest,
        "No renamable symbol at the given position",
      );
    }

    // Don't rename if old name equals new name
    if (renameResult.oldName === params.newName) {
      return new ResponseError(
        ErrorCodes.InvalidRequest,
        "New name is the same as the current name",
      );
    }

    return buildWorkspaceEdit(renameResult.locations, params.newName);
  });

  // -----------------------------------------------------------------------
  // textDocument/completion (decision 0012)
  // -----------------------------------------------------------------------

  connection.onCompletion(async (params, token: CancellationToken) => {
    // Check cancellation early — if a new keystroke already came in, bail
    if (token.isCancellationRequested) return { isIncomplete: false, items: [] };

    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return { isIncomplete: false, items: [] };

    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table || token.isCancellationRequested)
      return { isIncomplete: false, items: [] };

    try {
      const source = doc.getText();
      const tree = parse(source, params.textDocument.uri);
      if (token.isCancellationRequested)
        return { isIncomplete: false, items: [] };

      // Capture the identifier prefix range synchronously before any async
      // gap. The tree is stored in the parse() LRU cache and can be evicted
      // (and deleted) during an await — after which tree.rootNode is null.
      const prefixRange = findIdentifierPrefixRange(
        tree,
        params.position.line,
        params.position.character,
      );

      const result = await getCompletions(table, tree, params.position.line, params.position.character, {
        ...completionCtx,
        uri: params.textDocument.uri,
        source,
        typeInferrer: makeTypeInferrer(source),
      });

      // Add textEdit to each item so the client replaces the identifier
      // prefix being typed instead of inserting at the cursor position.
      // This prevents doubled text like "foo.bbar" when completing "bar"
      // after typing "foo.b".
      //
      // For call_args items (triggered by '('), the insertText is a snippet
      // that should be inserted at the cursor (right after the '('). These
      // items already have insertText but no textEdit — VSCode will insert
      // at cursor position, which is the desired behavior.
      if (prefixRange) {
        for (const item of result.items) {
          if (!item.textEdit) {
            // Use insertText (which may be a snippet) if available, else label.
            const newText = item.insertText ?? item.label;
            item.textEdit = {
              range: prefixRange,
              newText,
            };
            // insertText is redundant when textEdit is present; clear it
            // unless it's a snippet (in which case the textEdit carries it).
            delete item.insertText;
          }
        }
      }

      return result;
    } catch (err) {
      logError(connection, ErrorCategory.Diagnostics, "navigationHandler.handleCompletion", err);
      return { isIncomplete: false, items: [] };
    }
  });

  // -----------------------------------------------------------------------
  // Call hierarchy — incoming/outgoing calls (decision 0026)
  // -----------------------------------------------------------------------

  connection.onRequest(
    "textDocument/prepareCallHierarchy",
    async (params, token: CancellationToken) => {
      if (token.isCancellationRequested) return null;
      const table = await ctx.getSymbolTable(params.textDocument.uri);
      if (!table) return null;
      return prepareCallHierarchy(
        table,
        params.textDocument.uri,
        params.position.line,
        params.position.character,
      );
    },
  );

  connection.onRequest(
    "callHierarchy/incomingCalls",
    async (params, token: CancellationToken) => {
      if (token.isCancellationRequested) return [];
      const item = params.item;
      if (!ctx.index) return [];
      return getIncomingCalls(item, ctx.index);
    },
  );

  connection.onRequest(
    "callHierarchy/outgoingCalls",
    async (params, token: CancellationToken) => {
      if (token.isCancellationRequested) return [];
      const item = params.item;
      const uri = item.uri;
      const table = await ctx.getSymbolTable(uri);
      if (!table) return [];
      const doc = ctx.documents.get(uri);
      if (!doc) return [];
      const tree = parse(doc.getText(), uri);
      if (!ctx.index) return [];
      return getOutgoingCalls(item, tree, table, uri, ctx.index);
    },
  );

  // -----------------------------------------------------------------------
  // Code lens — reference counts above declarations (decision 0026)
  // -----------------------------------------------------------------------

  connection.onCodeLens(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return null;
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return null;

    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    const tree = parse(doc.getText(), params.textDocument.uri);
    return produceCodeLenses(table, tree, params.textDocument.uri, ctx.index);
  });

  // -----------------------------------------------------------------------
  // textDocument/didOpen — extract AutoDoc on document open (decision 0014)
  // -----------------------------------------------------------------------

  ctx.documents.onDidOpen((event) => {
    const doc = event.document;

    // Extract AutoDoc XML on open (non-critical, fire-and-forget)
    const source = doc.getText();
    // gopls sentinel pattern: return diagnostic-quality error for null/undefined.
    // Empty string is valid content — no guard needed.
    if (source === undefined || source === null) {
      logError(ctx.connection, ErrorCategory.System, `navigationHandler.handleHover(${doc.uri})`, new Error("unexpected null content"));
      return;
    }
    const autodocHash = computeContentHash(source);
    const cachedAutodoc = ctx.autodocCache.get(doc.uri);
    if (!cachedAutodoc || cachedAutodoc.hash !== autodocHash) {
      const filepath = uriToPath(doc.uri);
      ctx.worker
        .autodoc(source, filepath)
        .then((result) => {
          if (result.xml) {
            ctx.autodocCache.set(doc.uri, {
              xml: result.xml,
              hash: autodocHash,
              timestamp: Date.now(),
            });
          }
        })
        .catch((err: unknown) => {
          logWarn(ctx.connection, `AutoDoc extraction failed on didOpen for ${doc.uri}: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  });

  // -----------------------------------------------------------------------
  // textDocument/didSave — delegate to DiagnosticManager (decision 0013)
  // -----------------------------------------------------------------------

  ctx.documents.onDidSave(async (event) => {
    const doc = event.document;

    // Delegate to DiagnosticManager (handles cache, diagnose, publish)
    await ctx.diagnosticManager.onDidSave(doc.uri);

    // Extract AutoDoc XML alongside diagnostics (non-critical)
    const source = doc.getText();
    const autodocHash = computeContentHash(source);
    const cachedAutodoc = ctx.autodocCache.get(doc.uri);
    if (!cachedAutodoc || cachedAutodoc.hash !== autodocHash) {
      const filepath = uriToPath(doc.uri);
      ctx.worker
        .autodoc(source, filepath)
        .then((result) => {
          if (result.xml) {
            ctx.autodocCache.set(doc.uri, {
              xml: result.xml,
              hash: autodocHash,
              timestamp: Date.now(),
            });
          }
        })
        .catch((err: unknown) => {
          logWarn(ctx.connection, `AutoDoc extraction failed on didSave for ${doc.uri}: ${err instanceof Error ? err.message : String(err)}`);
        });
    }
  });

  // -----------------------------------------------------------------------
  // textDocument/documentLink (US-030)
  // -----------------------------------------------------------------------
  registerDocumentLinkHandler(connection, ctx.documents, ctx.index, ctx.index.resolver);
}