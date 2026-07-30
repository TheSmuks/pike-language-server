/**
 * Declarative capability matrix for the LSP audit sweep.
 *
 * Pure data: no I/O, no server. Each entry says how to build a request and how
 * to tell an answer from an empty result. `declaredBy` ties the entry back to
 * the key in buildServerCapabilities() that advertises it, which lets the test
 * suite fail when a capability is advertised but never swept.
 */

import { commentAndLiteralMask } from "./positions";

export type Driver = "position" | "document" | "workspace" | "lifecycle";

export interface RequestContext {
  uri: string;
  position: { line: number; character: number } | null;
  text: string;
  /** Set only for semanticTokens/full/delta, by the driver's edit cycle. */
  previousResultId?: string;
}

export interface CapabilitySpec {
  method: string;
  driver: Driver;
  declaredBy: string;
  params(ctx: RequestContext): unknown;
  /**
   * `ctx` is optional so a validator can be exercised on its own, but the sweep
   * always passes it. Some empties are only legal given the document — a file
   * with no multi-line construct has nothing to fold — and a validator that
   * cannot see the source has to choose between missing an outage and inventing
   * a finding.
   */
  validate(result: unknown, ctx?: RequestContext): "ok" | "empty";
}

// --- shared param builders -------------------------------------------------

const doc = (ctx: RequestContext) => ({ textDocument: { uri: ctx.uri } });
const at = (ctx: RequestContext) => ({ ...doc(ctx), position: ctx.position });

/** Whole-document range, for range-scoped requests. */
function fullRange(ctx: RequestContext) {
  const lines = ctx.text.split("\n");
  return {
    start: { line: 0, character: 0 },
    end: { line: Math.max(0, lines.length - 1), character: lines[lines.length - 1]?.length ?? 0 },
  };
}

// --- shared validators -----------------------------------------------------

/** Non-null, and non-empty when the result is an array. */
function nonEmpty(result: unknown): "ok" | "empty" {
  if (result === null || result === undefined) return "empty";
  if (Array.isArray(result)) return result.length > 0 ? "ok" : "empty";
  return "ok";
}

/** Anything at all, including an empty array. Used where empty is a legal answer. */
function anyResult(result: unknown): "ok" | "empty" {
  return result === undefined ? "empty" : "ok";
}

/** Completion returns either an array or a CompletionList. */
function completionNonEmpty(result: unknown): "ok" | "empty" {
  if (result === null || result === undefined) return "empty";
  if (Array.isArray(result)) return result.length > 0 ? "ok" : "empty";
  const items = (result as { items?: unknown[] }).items;
  return Array.isArray(items) && items.length > 0 ? "ok" : "empty";
}

/** Semantic tokens: the flat data array must be non-empty for a non-empty file. */
function tokensNonEmpty(result: unknown): "ok" | "empty" {
  const data = (result as { data?: number[] } | null)?.data;
  return Array.isArray(data) && data.length > 0 ? "ok" : "empty";
}

/**
 * A delta reply is legally either an edit list or a full token set. Both count
 * as an answer; only null does not. Whether the edits are *correct* is checked
 * by the driver, which knows what edit it made.
 */
function deltaAnswered(result: unknown): "ok" | "empty" {
  if (result === null || result === undefined) return "empty";
  const asDelta = result as { edits?: unknown[]; data?: unknown[] };
  return Array.isArray(asDelta.edits) || Array.isArray(asDelta.data) ? "ok" : "empty";
}

/**
 * True when the source contains a construct that spans more than one line.
 *
 * Braces inside comments and string literals are masked out first, so a `{` in
 * prose cannot make an unfoldable file look foldable — that would turn a
 * correct empty answer into a false finding, which is the exact failure this
 * whole check exists to avoid.
 */
export function hasFoldableRegion(text: string): boolean {
  const masked = commentAndLiteralMask(text);
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (masked[i]) continue;
    if (text[i] === "{" || text[i] === "(" || text[i] === "[") depth++;
    else if (text[i] === "}" || text[i] === ")" || text[i] === "]") depth = Math.max(0, depth - 1);
    else if (text[i] === "\n" && depth > 0) return true;
  }
  return false;
}

/**
 * Folding is mandatory only for a file that has something to fold.
 *
 * corpus/files/cross_pmod_dir.pmod/helpers.pike is five lines of one-line
 * function bodies: zero folding ranges is the correct answer, and a blanket
 * nonEmpty reported it as a defect. Dropping to anyResult instead would hide a
 * total folding outage, so the source decides.
 */
function foldingRangeAnswered(result: unknown, ctx?: RequestContext): "ok" | "empty" {
  if (ctx && !hasFoldableRegion(ctx.text)) return anyResult(result);
  return nonEmpty(result);
}

// --- the matrix ------------------------------------------------------------

export const MATRIX: CapabilitySpec[] = [
  // Position-driven.
  { method: "textDocument/hover", driver: "position", declaredBy: "hoverProvider", params: at, validate: nonEmpty },
  { method: "textDocument/definition", driver: "position", declaredBy: "definitionProvider", params: at, validate: nonEmpty },
  { method: "textDocument/declaration", driver: "position", declaredBy: "declarationProvider", params: at, validate: nonEmpty },
  { method: "textDocument/typeDefinition", driver: "position", declaredBy: "typeDefinitionProvider", params: at, validate: anyResult },
  { method: "textDocument/implementation", driver: "position", declaredBy: "implementationProvider", params: at, validate: anyResult },
  {
    method: "textDocument/references",
    driver: "position",
    declaredBy: "referencesProvider",
    params: (ctx) => ({ ...at(ctx), context: { includeDeclaration: true } }),
    validate: nonEmpty,
  },
  { method: "textDocument/prepareRename", driver: "position", declaredBy: "renameProvider", params: at, validate: anyResult },
  {
    method: "textDocument/rename",
    driver: "position",
    declaredBy: "renameProvider",
    params: (ctx) => ({ ...at(ctx), newName: "auditRenamedSymbol" }),
    validate: anyResult,
  },
  { method: "textDocument/documentHighlight", driver: "position", declaredBy: "documentHighlightProvider", params: at, validate: nonEmpty },
  {
    method: "textDocument/signatureHelp",
    driver: "position",
    declaredBy: "signatureHelpProvider",
    params: (ctx) => ({ ...at(ctx), context: { triggerKind: 1, isRetrigger: false } }),
    validate: anyResult,
  },
  {
    method: "textDocument/selectionRange",
    driver: "position",
    declaredBy: "selectionRangeProvider",
    params: (ctx) => ({ ...doc(ctx), positions: [ctx.position] }),
    validate: nonEmpty,
  },
  { method: "textDocument/prepareCallHierarchy", driver: "position", declaredBy: "callHierarchyProvider", params: at, validate: anyResult },
  { method: "textDocument/prepareTypeHierarchy", driver: "position", declaredBy: "typeHierarchyProvider", params: at, validate: anyResult },
  {
    method: "textDocument/completion",
    driver: "position",
    declaredBy: "completionProvider",
    params: (ctx) => ({ ...at(ctx), context: { triggerKind: 1 } }),
    validate: completionNonEmpty,
  },

  // Document-driven.
  { method: "textDocument/documentSymbol", driver: "document", declaredBy: "documentSymbolProvider", params: doc, validate: nonEmpty },
  { method: "textDocument/semanticTokens/full", driver: "document", declaredBy: "semanticTokensProvider", params: doc, validate: tokensNonEmpty },
  {
    method: "textDocument/semanticTokens/range",
    driver: "document",
    declaredBy: "semanticTokensProvider",
    params: (ctx) => ({ ...doc(ctx), range: fullRange(ctx) }),
    validate: tokensNonEmpty,
  },
  {
    // Driven by the sweep's edit cycle, not a bare request: a delta bug is
    // invisible until a specific edit sequence produces a wrong patch.
    method: "textDocument/semanticTokens/full/delta",
    driver: "document",
    declaredBy: "semanticTokensProvider",
    params: (ctx) => ({ ...doc(ctx), previousResultId: ctx.previousResultId ?? "" }),
    validate: deltaAnswered,
  },
  { method: "textDocument/foldingRange", driver: "document", declaredBy: "foldingRangeProvider", params: doc, validate: foldingRangeAnswered },
  { method: "textDocument/inlayHint", driver: "document", declaredBy: "inlayHintProvider", params: (ctx) => ({ ...doc(ctx), range: fullRange(ctx) }), validate: anyResult },
  { method: "textDocument/documentLink", driver: "document", declaredBy: "documentLinkProvider", params: doc, validate: anyResult },
  { method: "textDocument/codeLens", driver: "document", declaredBy: "codeLensProvider", params: doc, validate: anyResult },
  {
    method: "textDocument/codeAction",
    driver: "document",
    declaredBy: "codeActionProvider",
    params: (ctx) => ({ ...doc(ctx), range: fullRange(ctx), context: { diagnostics: [] } }),
    validate: anyResult,
  },
  {
    method: "textDocument/formatting",
    driver: "document",
    declaredBy: "documentFormattingProvider",
    params: (ctx) => ({ ...doc(ctx), options: { tabSize: 2, insertSpaces: true } }),
    validate: anyResult,
  },
  {
    method: "textDocument/rangeFormatting",
    driver: "document",
    declaredBy: "documentRangeFormattingProvider",
    params: (ctx) => ({ ...doc(ctx), range: fullRange(ctx), options: { tabSize: 2, insertSpaces: true } }),
    validate: anyResult,
  },
  {
    method: "textDocument/onTypeFormatting",
    driver: "document",
    declaredBy: "documentOnTypeFormattingProvider",
    params: (ctx) => ({ ...doc(ctx), position: { line: 0, character: 0 }, ch: "}", options: { tabSize: 2, insertSpaces: true } }),
    validate: anyResult,
  },

  // Workspace-driven.
  {
    method: "workspace/symbol",
    driver: "workspace",
    declaredBy: "workspaceSymbolProvider",
    params: () => ({ query: "create" }),
    validate: nonEmpty,
  },
  // Lifecycle. These are NOTIFICATIONS, not requests — the server implements
  // onDidRenameFiles and onDidChange, neither of which returns a response.
  // Firing them with sendRequest would hang until the timeout and report a
  // false Critical on every file, so the driver sends them as notifications
  // and records that the server survived. The entries exist here so the
  // coverage test still sees their declared keys.
  {
    method: "workspace/didRenameFiles",
    driver: "lifecycle",
    declaredBy: "workspace",
    params: (ctx) => ({ files: [{ oldUri: ctx.uri, newUri: ctx.uri.replace(/\.pike$/, "-renamed.pike") }] }),
    validate: anyResult,
  },
  {
    method: "textDocument/didChange",
    driver: "lifecycle",
    declaredBy: "textDocumentSync",
    params: (ctx) => ({
      textDocument: { uri: ctx.uri, version: 3 },
      contentChanges: [{ text: ctx.text }],
    }),
    validate: anyResult,
  },
];
