/**
 * Document feature handlers — documentSymbol, selectionRange, semanticTokens,
 * documentHighlight, foldingRange, signatureHelp, inlayHint.
 *
 * Extracted from navigationHandler.ts to keep file sizes under 500 lines.
 */

import {
  type Connection,
  type CancellationToken,
  type DocumentHighlight,
  type Position,
  DocumentHighlightKind,
} from "vscode-languageserver/node";
import type { NavigationContext } from "./navigationHandler";
import { initParser, isParserReady, parse } from "../parser";
import { getDocumentSymbols } from "./documentSymbol";
import {
  getDefinitionAt,
  getReferencesTo,
} from "./symbolTable";
import {
  produceSemanticTokens,
  deltaEncodeTokens,
  getExternalLookup,
  sliceSemanticTokens,
  type SemanticToken,
  type SemanticTokenRange,
} from "./semanticTokens";
import { produceFoldingRanges } from "./foldingRange";
import { produceSignatureHelp } from "./signatureHelp";
import { produceInlayHints } from "./inlayHints";
import { getSelectionRange } from "./selectionRange";
import { logError, logInfo, ErrorCategory } from "../util/errorLog.js";

/**
 * Register document analysis feature handlers on the connection.
 */
export function registerDocumentFeatureHandlers(
  connection: Connection,
  ctx: NavigationContext,
): void {
  connection.onDocumentSymbol((params, token) =>
    handleDocumentSymbol(connection, ctx, params, token));

  connection.onRequest("textDocument/selectionRange", (params, token) =>
    handleSelectionRange(ctx, params, token));

  connection.onRequest("textDocument/semanticTokens/full", (params, token) =>
    handleSemanticTokensFull(ctx, params, token));

  connection.onRequest("textDocument/semanticTokens/range", (params, token) =>
    handleSemanticTokensRange(ctx, params, token));

  connection.onDocumentHighlight((params, token) =>
    handleDocumentHighlight(ctx, params, token));

  connection.onRequest("textDocument/foldingRange", (params, token) =>
    handleFoldingRange(ctx, params, token));

  connection.onRequest("textDocument/signatureHelp", (params, token) =>
    handleSignatureHelp(ctx, params, token));

  connection.onRequest("textDocument/inlayHint", (params, token) =>
    handleInlayHint(ctx, params, token));
}

/** Handle textDocument/documentSymbol requests. */
async function handleDocumentSymbol(
  connection: Connection,
  ctx: NavigationContext,
  params: { textDocument: { uri: string } },
  token: CancellationToken,
) {
  if (token.isCancellationRequested) return [];
  const doc = ctx.documents.get(params.textDocument.uri);
  if (!doc) return [];

  try {
    const source = doc.getText();
    const tree = parse(source, doc.uri);
    const lines = source.split('\n');
    return getDocumentSymbols(tree, lines);
  } catch (err) {
    logError(connection, ErrorCategory.Parse, "navigationHandler.handleDocumentSymbol", err);
    return [];
  }
}

/** Handle textDocument/selectionRange requests. */
async function handleSelectionRange(
  ctx: NavigationContext,
  params: { textDocument: { uri: string }; positions: Array<{ line: number; character: number }> },
  token: CancellationToken,
) {
  if (token.isCancellationRequested) return null;
  const doc = ctx.documents.get(params.textDocument.uri);
  if (!doc) return null;

  const results = [];
  for (const pos of params.positions) {
    if (token.isCancellationRequested) return results;
    const source = doc.getText();
    const tree = parse(source, doc.uri);
    const lines = source.split('\n');
    const range = getSelectionRange(tree, pos.line, pos.character, lines);
    results.push(range);
  }
  return results;
}

/** Handle textDocument/semanticTokens/full requests. */
async function handleSemanticTokensFull(
  ctx: NavigationContext,
  params: { textDocument: { uri: string } },
  token: CancellationToken,
) {
  const data = await buildSemanticTokenData(ctx, params.textDocument.uri, token);
  return { data };
}

/** Handle textDocument/semanticTokens/range requests. */
async function handleSemanticTokensRange(
  ctx: NavigationContext,
  params: { textDocument: { uri: string }; range: SemanticTokenRange },
  token: CancellationToken,
) {
  const data = await buildSemanticTokenData(ctx, params.textDocument.uri, token, params.range);
  return { data };
}

export async function buildSemanticTokenData(
  ctx: NavigationContext,
  uri: string,
  token: CancellationToken,
  range?: SemanticTokenRange,
): Promise<number[]> {
  let doc = ctx.documents.get(uri);
  const docVersion = doc?.version;
  const cached = ctx.semanticTokensCache.get(uri);

  if (token.isCancellationRequested) {
    const fallback = getCachedSemanticTokenData(cached, docVersion, range);
    if (fallback) return fallback;
    return [];
  }

  if (!doc) {
    await Promise.resolve();
    doc = ctx.documents.get(uri);
  }
  if (!doc) return [];

  const parserReady = await ensureParserReadyForSemanticTokens(ctx);
  if (!parserReady) {
    const fallback = getCachedSemanticTokenData(cached, doc.version, range);
    if (fallback) return fallback;
    return [];
  }

  const table = await ctx.getSymbolTable(uri);
  if (!table) {
    const fallback = getCachedSemanticTokenData(cached, doc.version, range);
    if (fallback) return fallback;
    return [];
  }

  const externalLookup = getExternalLookup(ctx.predefBuiltins, ctx.stdlibIndex);
  const tokens = produceSemanticTokens(table, externalLookup);
  const data = deltaEncodeTokens(range ? sliceSemanticTokens(tokens, range) : tokens);
  if (data.length === 0) {
    const fallback = getCachedSemanticTokenData(cached, doc.version, range);
    if (fallback) return fallback;
  }
  if (!range) ctx.semanticTokensCache.set(uri, { version: doc.version, data, tokens });
  if (ctx.debugTelemetry) {
    logInfo(ctx.connection, `[telemetry] semanticTokens fresh uri=${uri} version=${doc.version} tokens=${data.length} range=${range ? "yes" : "no"}`);
  }
  return data;
}

function getCachedSemanticTokenData(
  cached: { version: number; data: number[]; tokens: SemanticToken[] } | undefined,
  docVersion: number | undefined,
  range?: SemanticTokenRange,
): number[] | null {
  if (!cached) return null;
  if (docVersion === undefined) return null;
  if (cached.version !== docVersion) return null;
  if (!range) return cached.data;
  return deltaEncodeTokens(sliceSemanticTokens(cached.tokens, range));
}

async function ensureParserReadyForSemanticTokens(ctx: NavigationContext): Promise<boolean> {
  if (isParserReady()) return true;
  try {
    await initParser();
    return isParserReady();
  } catch (err) {
    logError(ctx.connection, ErrorCategory.Parse, "semanticTokens.initParser", err);
    return false;
  }
}

/** Handle textDocument/documentHighlight requests. */
async function handleDocumentHighlight(
  ctx: NavigationContext,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
  token: CancellationToken,
) {
  if (token.isCancellationRequested) return null;
  const table = await ctx.getSymbolTable(params.textDocument.uri);
  if (!table || token.isCancellationRequested) return null;

  const refs = getReferencesTo(table, params.position.line, params.position.character);
  if (refs.length === 0) return null;

  const targetDecl = getDefinitionAt(table, params.position.line, params.position.character);
  return buildDocumentHighlights(targetDecl, refs);
}

/** Build DocumentHighlight[] from references and optional declaration. */
function buildDocumentHighlights(
  targetDecl: import("./symbolTable").Declaration | null,
  refs: Array<{ loc: { line: number; character: number }; name: string }>,
): DocumentHighlight[] | null {
  const highlights: DocumentHighlight[] = [];

  if (targetDecl) {
    highlights.push({
      range: {
        start: { line: targetDecl.nameRange.start.line, character: targetDecl.nameRange.start.character },
        end: { line: targetDecl.nameRange.end.line, character: targetDecl.nameRange.end.character },
      },
      kind: DocumentHighlightKind.Write,
    });
  }

  for (const ref of refs) {
    if (targetDecl && ref.loc.line === targetDecl.nameRange.start.line &&
        ref.loc.character === targetDecl.nameRange.start.character) {
      continue;
    }
    highlights.push({
      range: {
        start: { line: ref.loc.line, character: ref.loc.character },
        end: { line: ref.loc.line, character: ref.loc.character + ref.name.length },
      },
      kind: DocumentHighlightKind.Read,
    });
  }

  return highlights.length > 0 ? highlights : null;
}

/** Handle textDocument/foldingRange requests. */
async function handleFoldingRange(
  ctx: NavigationContext,
  params: { textDocument: { uri: string } },
  token: CancellationToken,
) {
  if (token.isCancellationRequested) return [];
  const doc = ctx.documents.get(params.textDocument.uri);
  if (!doc) return [];

  const tree = parse(doc.getText(), doc.uri);
  if (!tree) return [];
  return produceFoldingRanges(tree);
}

/** Handle textDocument/signatureHelp requests. */
async function handleSignatureHelp(
  ctx: NavigationContext,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
  token: CancellationToken,
) {
  if (token.isCancellationRequested) return null;
  const doc = ctx.documents.get(params.textDocument.uri);
  if (!doc) return null;

  const table = await ctx.getSymbolTable(params.textDocument.uri);
  if (!table || token.isCancellationRequested) return null;

  const source = doc.getText();
  const tree = parse(source, doc.uri);
  if (!tree) return null;

  return produceSignatureHelp(tree, table, params.position.line, params.position.character, ctx.stdlibIndex, {
    table, uri: params.textDocument.uri, index: ctx.index, stdlibIndex: ctx.stdlibIndex,
    typeInferrer: buildTypeInferrer(ctx, doc.uri),
  }, source);
}

/** Build a type inferrer callback for the PikeWorker. */
function buildTypeInferrer(ctx: NavigationContext, docUri: string): ((varName: string) => Promise<string | null>) | undefined {
  if (!ctx.worker) return undefined;
  return async (varName: string) => {
    try {
      const result = await ctx.worker.typeof_(docUri, varName);
      return result.type ?? null;
    } catch {
      return null;
    }
  };
}

/** Handle textDocument/inlayHint requests. */
async function handleInlayHint(
  ctx: NavigationContext,
  params: { textDocument: { uri: string }; range: { start: Position; end: Position } },
  token: CancellationToken,
) {
  if (token.isCancellationRequested) return [];
  const doc = ctx.documents.get(params.textDocument.uri);
  if (!doc) return [];

  const table = await ctx.getSymbolTable(params.textDocument.uri);
  if (!table || token.isCancellationRequested) return [];

  const source = doc.getText();
  const tree = parse(source, doc.uri);
  if (!tree) return [];

  return produceInlayHints({ tree, table, range: params.range, lines: source.split('\n') });
}
