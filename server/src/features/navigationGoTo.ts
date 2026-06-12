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
import { prepareGlobalQuery } from "./workspaceResolution";
import { logInfo } from "../util/errorLog.js";

/**
 * Register go-to navigation handlers on the connection.
 */
export function registerGoToHandlers(
  connection: Connection,
  ctx: NavigationContext,
): void {
  const makeTypeInferrer = buildTypeInferrerFactory(ctx);
  const resolutionCtx: ResolutionContext = {
    documents: ctx.documents,
    index: ctx.index,
    stdlibIndex: ctx.stdlibIndex,
  };

  connection.onDefinition((params, token) =>
    handleDefinition(connection, ctx, resolutionCtx, makeTypeInferrer, params, token));

  connection.onReferences((params, token) =>
    handleReferences(ctx, params, token));

  connection.onRequest("textDocument/implementation", (params, token) =>
    handleImplementation(connection, ctx, params, token));
}

/** Build a source-aware type inferrer factory using PikeWorker.typeof_(). */
function buildTypeInferrerFactory(
  ctx: NavigationContext,
): (source: string) => (varName: string) => Promise<string | null> {
  return (source: string) => {
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
}

/** Handle textDocument/definition requests. */
async function handleDefinition(
  _connection: Connection,
  ctx: NavigationContext,
  resolutionCtx: ResolutionContext,
  makeTypeInferrer: (source: string) => (varName: string) => Promise<string | null>,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
  token: CancellationToken,
): Promise<LspLocation | LspLocation[] | null> {
  if (token.isCancellationRequested) return null;

  const includeDoc = ctx.documents.get(params.textDocument.uri);
  if (includeDoc) {
    const includeResult = resolveIncludeTarget(
      includeDoc, params.textDocument.uri,
      params.position.line, params.position.character,
      ctx.index.pikePaths.includePaths, ctx.index.workspaceRoot,
    );
    if (includeResult) return includeResult;
  }

  const table = await ctx.getSymbolTable(params.textDocument.uri);
  if (!table) return null;

  const decl = getDefinitionAt(table, params.position.line, params.position.character);
  if (decl) return resolveDeclLocation(decl, table, params);

  const crossFile = await ctx.index.resolveCrossFileDefinition(
    params.textDocument.uri, params.position.line, params.position.character,
  );
  if (crossFile) {
    if (token.isCancellationRequested) return null;
    return declToLspLocation(crossFile.uri, crossFile.decl);
  }

  return resolveAccessForDefinition(ctx, resolutionCtx, makeTypeInferrer, table, params);
}

/** Resolve a local declaration to its LSP location(s). */
function resolveDeclLocation(
  decl: import("./symbolTable").Declaration,
  table: import("./symbolTable").SymbolTable,
  params: { position: { line: number; character: number } },
): LspLocation | LspLocation[] {
  const nr = decl.nameRange;
  const cursorOnDeclName = nr.start.line === params.position.line &&
    params.position.character >= nr.start.character &&
    params.position.character < nr.end.character;

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

  return declToLspLocation(decl.sourceUri ?? table.uri, decl);
}

/** Convert a declaration to an LSP Location. */
function declToLspLocation(uri: string, decl: { nameRange: { start: { line: number; character: number }; end: { line: number; character: number } } }): LspLocation {
  return {
    uri,
    range: {
      start: { line: decl.nameRange.start.line, character: decl.nameRange.start.character },
      end: { line: decl.nameRange.end.line, character: decl.nameRange.end.character },
    },
  };
}

/** Try arrow/dot access resolution for go-to-definition. */
async function resolveAccessForDefinition(
  ctx: NavigationContext,
  resolutionCtx: ResolutionContext,
  makeTypeInferrer: (source: string) => (varName: string) => Promise<string | null>,
  table: import("./symbolTable").SymbolTable,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
): Promise<LspLocation | null> {
  const doc = ctx.documents.get(params.textDocument.uri);
  const accessTree = doc ? parse(doc.getText(), params.textDocument.uri) : undefined;
  const accessResolutionCtx: ResolutionContext = doc
    ? { ...resolutionCtx, typeInferrer: makeTypeInferrer(doc.getText()) }
    : resolutionCtx;
  return resolveAccessDefinition(
    accessResolutionCtx, table, params.textDocument.uri,
    params.position.line, params.position.character, accessTree,
  );
}

/** Handle textDocument/references requests. */
async function handleReferences(
  ctx: NavigationContext,
  params: { textDocument: { uri: string }; position: { line: number; character: number }; context?: { includeDeclaration?: boolean } },
  token: CancellationToken,
): Promise<LspLocation[]> {
  if (token.isCancellationRequested) return [];
  const table = await ctx.getSymbolTable(params.textDocument.uri);
  if (!table) return [];

  // Ensure the workspace is fully indexed for complete cross-file reference
  // results. In openFiles mode this triggers a one-time full scan with
  // progress and cancellation support (contracts/lsp-resource-state.md).
  await prepareGlobalQuery({
    connection: ctx.connection,
    index: ctx.index,
    workspaceRoot: ctx.index.workspaceRoot,
    cancellationToken: token,
  });
  if (token.isCancellationRequested) return [];

  const includeDeclaration = params.context?.includeDeclaration === true;

  const crossFileRefs = ctx.index.getCrossFileReferences(
    params.textDocument.uri, params.position.line, params.position.character,
  );
  if (crossFileRefs.length > 0) {
    return buildCrossFileRefResults(crossFileRefs, table, params, includeDeclaration);
  }

  // Fallback: for unresolved symbols in freshly-opened files, ask async cross-file
  // definition resolution (which can trigger on-demand indexing) then re-run
  // reference lookup anchored at the resolved declaration position.
  const crossFileDecl = await ctx.index.resolveCrossFileDefinition(
    params.textDocument.uri,
    params.position.line,
    params.position.character,
  );
  if (crossFileDecl) {
    const anchoredRefs = ctx.index.getCrossFileReferences(
      crossFileDecl.uri,
      crossFileDecl.decl.nameRange.start.line,
      crossFileDecl.decl.nameRange.start.character,
    );
    if (ctx.debugTelemetry) {
      logInfo(
        ctx.connection,
        `[telemetry] references cross-file-fallback uri=${params.textDocument.uri} targetUri=${crossFileDecl.uri} refs=${anchoredRefs.length}`,
      );
    }
    if (anchoredRefs.length > 0) {
      let results = anchoredRefs.map(({ uri, ref }) => ({
        uri,
        range: {
          start: { line: ref.loc.line, character: ref.loc.character },
          end: { line: ref.loc.line, character: ref.loc.character + ref.name.length },
        },
      }));
      if (includeDeclaration) {
        const declLoc = declToLspLocation(crossFileDecl.uri, crossFileDecl.decl);
        const duplicateDecl = results.some(
          r => r.uri === declLoc.uri &&
            r.range.start.line === declLoc.range.start.line &&
            r.range.start.character === declLoc.range.start.character,
        );
        if (!duplicateDecl) results.unshift(declLoc);
      }
      return results;
    }
  }

  return buildSameFileRefResults(table, params, includeDeclaration);
}

/** Build reference results from cross-file references. */
function buildCrossFileRefResults(
  crossFileRefs: Array<{ uri: string; ref: { loc: { line: number; character: number }; name: string } }>,
  table: import("./symbolTable").SymbolTable,
  params: { position: { line: number; character: number } },
  includeDeclaration: boolean,
): LspLocation[] {
  let results = crossFileRefs.map(({ uri, ref }) => ({
    uri,
    range: {
      start: { line: ref.loc.line, character: ref.loc.character },
      end: { line: ref.loc.line, character: ref.loc.character + ref.name.length },
    },
  }));
  if (includeDeclaration) {
    results = prependDeclIfNotDuplicate(results, table, params);
  }
  return results;
}

/** Build reference results from same-file references. */
function buildSameFileRefResults(
  table: import("./symbolTable").SymbolTable,
  params: { position: { line: number; character: number } },
  includeDeclaration: boolean,
): LspLocation[] {
  const refs = getReferencesTo(table, params.position.line, params.position.character);
  let results = refs.map(ref => ({
    uri: table.uri,
    range: {
      start: { line: ref.loc.line, character: ref.loc.character },
      end: { line: ref.loc.line, character: ref.loc.character + ref.name.length },
    },
  }));
  if (includeDeclaration) {
    results = prependDeclIfNotDuplicate(results, table, params);
  }
  return results;
}

/** Prepend the declaration location to results if it's not already present. */
function prependDeclIfNotDuplicate(
  results: LspLocation[],
  table: import("./symbolTable").SymbolTable,
  params: { position: { line: number; character: number } },
): LspLocation[] {
  const decl = getDefinitionAt(table, params.position.line, params.position.character);
  if (!decl) return results;
  const declLoc = declToLspLocation(table.uri, decl);
  const isDuplicate = results.some(
    r => r.range.start.line === declLoc.range.start.line &&
      r.range.start.character === declLoc.range.start.character,
  );
  if (!isDuplicate) results.unshift(declLoc);
  return results;
}

/** Handle textDocument/implementation requests. */
async function handleImplementation(
  connection: Connection,
  ctx: NavigationContext,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
  token: CancellationToken,
): Promise<Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }>> {
  if (token.isCancellationRequested) return [];

  // Implementations span the whole workspace — ensure complete results.
  await prepareGlobalQuery({
    connection, index: ctx.index,
    workspaceRoot: ctx.index.workspaceRoot, cancellationToken: token,
  });
  if (token.isCancellationRequested) return [];

  return findImplementations(ctx.index, params.textDocument.uri, params.position.line, params.position.character)
    .map(impl => ({ uri: impl.uri, range: impl.range }));
}
