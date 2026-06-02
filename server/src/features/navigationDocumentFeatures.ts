/**
 * Document feature handlers — documentSymbol, selectionRange, semanticTokens,
 * diagnostic (pull), documentHighlight, foldingRange, signatureHelp, inlayHint.
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
import { parse } from "../parser";
import { getDocumentSymbols } from "./documentSymbol";
import { getParseDiagnostics } from "./diagnostics";
import {
  getDefinitionAt,
  getReferencesTo,
  buildSymbolTable,
} from "./symbolTable";
import {
  produceSemanticTokens,
  deltaEncodeTokens,
  getExternalLookup,
} from "./semanticTokens";
import { produceFoldingRanges } from "./foldingRange";
import { produceSignatureHelp } from "./signatureHelp";
import { produceInlayHints } from "./inlayHints";
import { runLintRules } from "./lintRules";
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
    handleSemanticTokens(ctx, params, token));

  connection.onRequest("textDocument/diagnostic", (params, token) =>
    handleDiagnostic(connection, ctx, params, token));

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
    const tree = parse(doc.getText(), doc.uri);
    const range = getSelectionRange(tree, pos.line, pos.character);
    results.push(range);
  }
  return results;
}

/** Handle textDocument/semanticTokens/full requests. */
async function handleSemanticTokens(
  ctx: NavigationContext,
  params: { textDocument: { uri: string } },
  token: CancellationToken,
) {
  const uri = params.textDocument.uri;
  const doc = ctx.documents.get(uri);
  const docVersion = doc?.version;
  const cached = ctx.semanticTokensCache.get(uri);

  // Cancellation is often transient during rapid edits/reindex. Reuse cached
  // tokens only when they match the current document version. Version-mismatched
  // cached ranges can paint partial words (e.g. "funct`ion"-style splits).
  if (token.isCancellationRequested) {
    if (cached && docVersion !== undefined && cached.version === docVersion) {
      if (ctx.debugTelemetry) {
        logInfo(ctx.connection, `[telemetry] semanticTokens cache-hit-on-cancel uri=${uri} version=${docVersion} tokens=${cached.data.length}`);
      }
      return { data: cached.data };
    }
    if (ctx.debugTelemetry) {
      logInfo(ctx.connection, `[telemetry] semanticTokens dropped-on-cancel uri=${uri} docVersion=${docVersion ?? "none"} cacheVersion=${cached?.version ?? "none"}`);
    }
    return { data: [] };
  }

  if (!doc) return { data: [] };

  const table = await ctx.getSymbolTable(uri);
  if (!table) {
    if (cached && cached.version === doc.version) {
      if (ctx.debugTelemetry) {
        logInfo(ctx.connection, `[telemetry] semanticTokens cache-hit-no-table uri=${uri} version=${doc.version} tokens=${cached.data.length}`);
      }
      return { data: cached.data };
    }
    if (ctx.debugTelemetry) {
      logInfo(ctx.connection, `[telemetry] semanticTokens empty-no-table uri=${uri} version=${doc.version}`);
    }
    return { data: [] };
  }

  const externalLookup = getExternalLookup(ctx.predefBuiltins, ctx.stdlibIndex);
  const tokens = produceSemanticTokens(table, externalLookup);
  const data = deltaEncodeTokens(tokens);
  ctx.semanticTokensCache.set(uri, { version: doc.version, data });
  if (ctx.debugTelemetry) {
    logInfo(ctx.connection, `[telemetry] semanticTokens fresh uri=${uri} version=${doc.version} tokens=${data.length}`);
  }
  return { data };
}

/** Handle textDocument/diagnostic (pull diagnostics) requests. */
async function handleDiagnostic(
  connection: Connection,
  ctx: NavigationContext,
  params: { textDocument: { uri: string } },
  token: CancellationToken,
) {
  if (token.isCancellationRequested) return { kind: "full", items: [] };
  const doc = ctx.documents.get(params.textDocument.uri);
  if (!doc) return { kind: "full", items: [] };

  try {
    const source = doc.getText();
    const tree = parse(source, params.textDocument.uri);
    const parseDiagnostics = getParseDiagnostics(tree, source.split('\n'));
    const table = buildSymbolTable(tree, params.textDocument.uri, doc.version);
    const lintDiagnostics = runLintRules(tree, table, source);
    const diagnostics = [...parseDiagnostics, ...lintDiagnostics];
    return { kind: "full", items: diagnostics };
  } catch (err) {
    logError(connection, ErrorCategory.Diagnostics, "navigationHandler.handleDiagnostics", err);
    return { kind: "full", items: [] };
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
