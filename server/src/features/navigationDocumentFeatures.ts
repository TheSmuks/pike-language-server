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
  ResponseError,
} from "vscode-languageserver/node";
import { LSPErrorCodes } from "vscode-languageserver-protocol/lib/common/api";
import type { NavigationContext } from "./navigationHandler";
import { initParser, isParserReady, parse } from "../parser";
import { getDocumentSymbols } from "./documentSymbol";
import {
  getDefinitionAt,
  getReferencesTo,
  type SymbolTable,
} from "./symbolTable";
import { buildSymbolTable } from "./symbolTable";
import {
  produceSemanticTokens,
  deltaEncodeTokens,
  getExternalLookup,
  sliceSemanticTokens,
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

  if (token.isCancellationRequested) {
    throwSemanticTokensCancelled();
  }

  if (!doc) {
    await Promise.resolve();
    doc = ctx.documents.get(uri);
  }
  if (!doc) throwSemanticTokensContentModified();

  const parserReady = await ensureParserReadyForSemanticTokens(ctx);
  if (!parserReady) {
    throwSemanticTokensContentModified();
  }

  await awaitInFlightUpsert(ctx, uri, token);
  const table = await ctx.getSymbolTable(uri);
  if (token.isCancellationRequested) {
    throwSemanticTokensCancelled();
  }
  const currentDoc = ctx.documents.get(uri);
  if (!currentDoc) throwSemanticTokensContentModified();
  if (!table) {
    return buildDirectSemanticTokenData(ctx, uri, currentDoc, range);
  }
  if (table.version !== currentDoc.version) {
    throwSemanticTokensContentModified();
  }
  if (documentHasParseError(uri, currentDoc)) {
    throwSemanticTokensContentModified();
  }

  return encodeSemanticTokenData(ctx, table, range);
}

function encodeSemanticTokenData(
  ctx: NavigationContext,
  table: SymbolTable,
  range?: SemanticTokenRange,
): number[] {
  const externalLookup = getExternalLookup(ctx.predefBuiltins, ctx.stdlibIndex);
  const tokens = produceSemanticTokens(table, externalLookup);
  const data = deltaEncodeTokens(range ? sliceSemanticTokens(tokens, range) : tokens);
  if (ctx.debugTelemetry) {
    logInfo(ctx.connection, `[telemetry] semanticTokens fresh uri=${table.uri} version=${table.version} tokens=${data.length} range=${range ? "yes" : "no"}`);
  }
  return data;
}

function buildDirectSemanticTokenData(
  ctx: NavigationContext,
  uri: string,
  doc: { version: number; getText(): string },
  range?: SemanticTokenRange,
): number[] {
  try {
    const source = doc.getText();
    const tree = parse(source, uri);
    if (treeHasError(tree)) {
      throwSemanticTokensContentModified();
    }
    const table = buildSymbolTable(tree, uri, doc.version, undefined, source);
    const externalLookup = getExternalLookup(ctx.predefBuiltins, ctx.stdlibIndex);
    const tokens = produceSemanticTokens(table, externalLookup);
    const data = deltaEncodeTokens(range ? sliceSemanticTokens(tokens, range) : tokens);
    return data;
  } catch (err) {
    logError(ctx.connection, ErrorCategory.Parse, "semanticTokens.direct", err);
    throwSemanticTokensContentModified();
  }
}

function documentHasParseError(
  uri: string,
  doc: { getText(): string },
): boolean {
  return treeHasError(parse(doc.getText(), uri));
}

function treeHasError(tree: { rootNode?: { hasError?: boolean } }): boolean {
  return tree.rootNode?.hasError === true;
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

async function awaitInFlightUpsert(
  ctx: NavigationContext,
  uri: string,
  token: CancellationToken,
): Promise<void> {
  const inFlight = ctx.upsertInFlight?.get(uri);
  if (!inFlight) return;
  await inFlight;
  if (token.isCancellationRequested) {
    throwSemanticTokensCancelled();
  }
}

function throwSemanticTokensContentModified(): never {
  throw new ResponseError(LSPErrorCodes.ContentModified, "content modified");
}

function throwSemanticTokensCancelled(): never {
  throw new ResponseError(LSPErrorCodes.RequestCancelled, "request cancelled");
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
