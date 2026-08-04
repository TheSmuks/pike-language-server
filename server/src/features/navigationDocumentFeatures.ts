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
  getLocalDeclarationAt,
  declOccurrenceRangeAt,
  getDefinitionAt,
  getReferencesTo,
  type SymbolTable,
} from "./symbolTable";
import { buildSymbolTable } from "./symbolTable";
import { isWrittenInFile } from "./query";
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
import {
  semanticTokensCache,
  nextSemanticTokensResultId,
  diffSemanticTokens,
} from "./semanticTokensDelta";
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

  connection.onRequest("textDocument/semanticTokens/full/delta", (params, token) =>
    handleSemanticTokensDelta(ctx, params, token));

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
    return getDocumentSymbols(tree);
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
    const range = getSelectionRange(tree, pos.line, pos.character);
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
  const resultId = nextSemanticTokensResultId();
  semanticTokensCache.set(params.textDocument.uri, { resultId, data });
  return { resultId, data };
}

/**
 * Handle textDocument/semanticTokens/full/delta requests.
 *
 * When the client's previousResultId matches our cached tokens for this URI we
 * return only the array edits; otherwise (cache miss / evicted / stale id) we
 * fall back to a full token set, which the protocol permits.
 */
async function handleSemanticTokensDelta(
  ctx: NavigationContext,
  params: { textDocument: { uri: string }; previousResultId: string },
  token: CancellationToken,
) {
  const uri = params.textDocument.uri;
  const newData = await buildSemanticTokenData(ctx, uri, token);
  const resultId = nextSemanticTokensResultId();

  const cached = semanticTokensCache.get(uri);
  semanticTokensCache.set(uri, { resultId, data: newData });

  if (!cached || cached.resultId !== params.previousResultId) {
    // Client holds tokens we can't diff against — send a full replacement.
    return { resultId, data: newData };
  }

  const edits = diffSemanticTokens(cached.data, newData);
  return { resultId, edits };
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

  // tree-sitter is error-tolerant: a version-matched table still holds correct
  // declarations for the parts that parsed, so we return their tokens even when
  // a stray ERROR node exists elsewhere. A transient parse error occurs on
  // nearly every keystroke while typing; rejecting here used to clear ALL
  // semantic highlighting for the whole file, so tokens flickered off mid-edit
  // and never appeared for files with tree-sitter grammar gaps. Only when we
  // truly produced nothing AND the tree is broken do we fall back to
  // ContentModified (keep the client's prior tokens) rather than destructively
  // clearing the file to empty.
  const data = encodeSemanticTokenData(ctx, table, range);
  if (data.length === 0 && documentHasParseError(uri, currentDoc)) {
    throwSemanticTokensContentModified();
  }
  return data;
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
  let data: number[];
  let treeErr: boolean;
  try {
    const source = doc.getText();
    const tree = parse(source, uri);
    treeErr = treeHasError(tree);
    const table = buildSymbolTable(tree, uri, doc.version, undefined, source);
    const externalLookup = getExternalLookup(ctx.predefBuiltins, ctx.stdlibIndex);
    const tokens = produceSemanticTokens(table, externalLookup);
    data = deltaEncodeTokens(range ? sliceSemanticTokens(tokens, range) : tokens);
  } catch (err) {
    logError(ctx.connection, ErrorCategory.Parse, "semanticTokens.direct", err);
    throwSemanticTokensContentModified();
  }
  // Same rationale as buildSemanticTokenData: serve best-effort tokens from the
  // partial tree; only keep the client's prior tokens (ContentModified) when we
  // produced nothing at all and the tree is broken.
  if (data.length === 0 && treeErr) {
    throwSemanticTokensContentModified();
  }
  return data;
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
  const source = ctx.documents.get(params.textDocument.uri)?.getText();
  if (!source) return null;

  // No early return on an empty ref list: a declaration with no other uses is
  // still one occurrence, and LSP asks for every highlight at the position.
  // buildDocumentHighlights already yields null when nothing is found, so the
  // guard that used to sit here only ever suppressed the lone-declaration case.
  const refs = getReferencesTo(table, params.position.line, params.position.character);
  // getDefinitionAt answers null on an inherit or import naming another file,
  // which is right for navigation and wrong here: the module name under the
  // cursor is itself an occurrence in this document.
  const localDecl = getLocalDeclarationAt(
    table, params.position.line, params.position.character,
  );
  const targetDecl = getDefinitionAt(table, params.position.line, params.position.character)
    ?? localDecl;

  // A renamed inherit is written twice — the path and the alias. Highlight the
  // one the cursor is on, not whichever the declaration happens to record as
  // its name.
  //
  // A declaration cloned from an inherited or #include'd file carries THAT
  // file's coordinates, so its range is not a range in this document: it
  // painted a six-character highlight onto a blank line here. The references
  // below still cover every occurrence written in this file.
  const declRange = targetDecl && isWrittenInFile(table, targetDecl)
    ? declOccurrenceRangeAt(targetDecl, params.position.line, params.position.character)
      ?? targetDecl.nameRange
    : null;

  // The word under the cursor is always an occurrence. For `inherit Animal;`
  // where Animal is declared in the SAME file, getDefinitionAt resolves through
  // to the class, so declRange became the class's own name on another line and
  // the clause the user clicked was left unpainted.
  const cursorRange = localDecl
    ? declOccurrenceRangeAt(localDecl, params.position.line, params.position.character)
    : null;

  return buildDocumentHighlights(declRange, refs, cursorRange, source);
}

/** Build DocumentHighlight[] from references and the declaration's own range. */
function buildDocumentHighlights(
  declRange: import("./symbolTable").Declaration["nameRange"] | null,
  refs: Array<{ loc: { line: number; character: number }; name: string }>,
  cursorRange?: import("./symbolTable").Declaration["nameRange"] | null,
  source = "",
): DocumentHighlight[] | null {
  const highlights: DocumentHighlight[] = [];
  const emitted = new Set<string>();

  const pushWrite = (range: import("./symbolTable").Declaration["nameRange"]): void => {
    const key = `${range.start.line}:${range.start.character}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    highlights.push({
      range: {
        start: { line: range.start.line, character: range.start.character },
        end: { line: range.end.line, character: range.end.character },
      },
      kind: DocumentHighlightKind.Write,
    });
  };

  if (declRange) pushWrite(declRange);
  if (cursorRange) pushWrite(cursorRange);

  const lines = source.split("\n");
  for (const ref of refs) {
    if (emitted.has(`${ref.loc.line}:${ref.loc.character}`)) continue;
    highlights.push({
      range: {
        start: { line: ref.loc.line, character: ref.loc.character },
        end: { line: ref.loc.line, character: ref.loc.character + ref.name.length },
      },
      kind: isAssignmentTarget(ref, lines) ? DocumentHighlightKind.Write : DocumentHighlightKind.Read,
    });
  }

  return highlights.length > 0 ? highlights : null;
}

/** An occurrence followed by a lone assignment operator is a write. */
function isAssignmentTarget(
  ref: { loc: { line: number; character: number }; name: string },
  lines: string[],
): boolean {
  const line = lines[ref.loc.line];
  if (!line) return false;
  const afterName = line.slice(ref.loc.character + ref.name.length);
  return /^\s*=(?!=)/.test(afterName);
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
    predefBuiltins: ctx.predefBuiltins, predefAutodoc: ctx.predefAutodoc,
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

  return produceInlayHints({ tree, table, range: params.range });
}
