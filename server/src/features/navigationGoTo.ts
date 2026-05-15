/**
 * Go-to navigation handlers — definition, references, implementation.
 *
 * Extracted from navigationHandler.ts to keep file sizes under 500 lines.
 */

import {
  type Connection,
  type CancellationToken,
  type Location as LspLocation,
} from "vscode-languageserver/node";
import type { NavigationContext } from "./navigationHandler";
import type { ResolutionContext } from "./accessResolver";
import { parse } from "../parser";
import {
  getDefinitionAt,
  getReferencesTo,
} from "./symbolTable";
import { resolveAccessDefinition } from "./accessResolver";
import { findImplementations } from "./implementation";
import { resolveIncludeTarget } from "./navigationInclude";

/**
 * Register go-to navigation handlers on the connection.
 */
export function registerGoToHandlers(
  connection: Connection,
  ctx: NavigationContext,
): void {
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

  const resolutionCtx: ResolutionContext = {
    documents: ctx.documents,
    index: ctx.index,
    stdlibIndex: ctx.stdlibIndex,
  };

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
}
