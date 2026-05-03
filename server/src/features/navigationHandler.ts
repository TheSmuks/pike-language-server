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
  DocumentHighlightKind,
} from "vscode-languageserver/node";
import type { TextDocuments } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { parse } from "../parser";
import { getDocumentSymbols } from "./documentSymbol";
import { getParseDiagnostics } from "./diagnostics";
import {
  getDefinitionAt,
  getReferencesTo,
  type SymbolTable,
} from "./symbolTable";
import { getCompletions, type CompletionContext } from "./completion";
import type { WorkspaceIndex } from "./workspaceIndex";
import { findImplementations } from "./implementation";
import {
  produceSemanticTokens,
  deltaEncodeTokens,
  SEMANTIC_TOKENS_LEGEND,
} from "./semanticTokens";
import { produceFoldingRanges } from "./foldingRange";
import { produceSignatureHelp } from "./signatureHelp";
import { produceCodeActions } from "./codeAction";
import { searchWorkspaceSymbols } from "./workspaceSymbol";
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

  connection.onDocumentSymbol(async (params) => {
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return [];

    try {
      const tree = parse(doc.getText(), doc.uri);

      // Report parse errors as diagnostics.
      const diagnostics = getParseDiagnostics(tree);
      connection.sendDiagnostics({ uri: doc.uri, diagnostics });

      // Return partial symbols — never crash on parse errors.
      return getDocumentSymbols(tree);
    } catch (err) {
      connection.console.error(
        `documentSymbol failed: ${(err as Error).message}`,
      );
      return [];
    }
  });

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
  // textDocument/documentHighlight (US-015)
  // -----------------------------------------------------------------------

  connection.onDocumentHighlight(async (params) => {
    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table) return null;

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

  connection.onRequest("textDocument/foldingRange", async (params) => {
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return [];

    const tree = parse(doc.getText(), doc.uri);
    if (!tree) return [];

    return produceFoldingRanges(tree);
  });

  // -----------------------------------------------------------------------
  // textDocument/signatureHelp (US-017)
  // -----------------------------------------------------------------------

  connection.onRequest("textDocument/signatureHelp", async (params) => {
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return null;

    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    const tree = parse(doc.getText(), doc.uri);
    if (!tree) return null;

    return produceSignatureHelp(
      tree,
      table,
      params.position.line,
      params.position.character,
      ctx.stdlibIndex,
    );
  });

  // -----------------------------------------------------------------------
  // textDocument/codeAction (US-018)
  // -----------------------------------------------------------------------

  connection.onCodeAction(async (params) => {
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return [];

    return produceCodeActions(params, doc.getText(), { stdlibModules });
  });

  // -----------------------------------------------------------------------
  // workspace/symbol (US-020)
  // -----------------------------------------------------------------------

  connection.onRequest("workspace/symbol", async (params) => {
    const query = params.query ?? "";
    return searchWorkspaceSymbols(query, ctx.index);
  });

  // -----------------------------------------------------------------------
  // textDocument/definition
  // -----------------------------------------------------------------------

  connection.onDefinition(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return null;
    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    // Try same-file resolution first
    const decl = getDefinitionAt(
      table,
      params.position.line,
      params.position.character,
    );

    if (decl) {
      const loc: LspLocation = {
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

    // Try cross-file references
    const crossFileRefs = ctx.index.getCrossFileReferences(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    );

    if (crossFileRefs.length > 0) {
      return crossFileRefs.map(({ uri, ref }) => ({
        uri,
        range: {
          start: { line: ref.loc.line, character: ref.loc.character },
          end: {
            line: ref.loc.line,
            character: ref.loc.character + ref.name.length,
          },
        },
      }));
    }

    // Fallback to same-file references
    const refs = getReferencesTo(
      table,
      params.position.line,
      params.position.character,
    );

    return refs.map((ref) => ({
      uri: table.uri,
      range: {
        start: { line: ref.loc.line, character: ref.loc.character },
        end: {
          line: ref.loc.line,
          character: ref.loc.character + ref.name.length,
        },
      },
    }));
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

    // Validate new name
    const validationError = validateRenameName(params.newName);
    if (validationError) {
      // LSP spec: return null or throw. We return null — client shows error UI.
      return null;
    }

    const renameResult = await getRenameLocations(
      table,
      params.textDocument.uri,
      params.position.line,
      params.position.character,
      ctx.index,
      protectedNames,
    );

    if (!renameResult) return null;

    // Don't rename if old name equals new name
    if (renameResult.oldName === params.newName) return null;

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
      const tree = parse(doc.getText(), params.textDocument.uri);
      if (token.isCancellationRequested)
        return { isIncomplete: false, items: [] };
      return await getCompletions(table, tree, params.position.line, params.position.character, {
        ...completionCtx,
        uri: params.textDocument.uri,
        typeInferrer: makeTypeInferrer(doc.getText()),
      });
    } catch (err) {
      connection.console.error(
        `completion failed: ${(err as Error).message}`,
      );
      return { isIncomplete: false, items: [] };
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
      const filepath = doc.uri.startsWith("file://")
        ? doc.uri.slice(7)
        : doc.uri;
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
        .catch(() => {}); // Non-critical
    }
  });
}
