/**
 * Stdlib secondary index and auto-import support for Pike LSP.
 *
 * Extracted from completionTrigger.ts: lazy caches that map stdlib FQNs
 * to children / top-level modules / auto-import entries.
 */

import { CompletionItemKind } from "vscode-languageserver/node";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StdlibEntry {
  signature: string;
  markdown: string;
}

interface StdlibMember {
  name: string;
  fqn: string;
  signature: string;
  kind: CompletionItemKind;
}

// ---------------------------------------------------------------------------
// Stdlib secondary index — prefix → direct children
// ---------------------------------------------------------------------------

let stdlibChildrenMap: Map<string, StdlibMember[]> | null = null;
let stdlibTopLevelNames: { name: string; kind: CompletionItemKind }[] | null = null;

/**
 * Build the secondary stdlib index (lazy, once).
 * Maps FQN prefixes like "predef.Stdio.File" to their direct child members.
 */
function buildStdlibChildrenMap(
  stdlibIndex: Record<string, StdlibEntry>,
): Map<string, StdlibMember[]> {
  const map = new Map<string, StdlibMember[]>();

  for (const [fqn, entry] of Object.entries(stdlibIndex)) {
    const parts = fqn.split(".");
    if (parts.length < 2 || parts[0] !== "predef") continue;

    // The direct child name is the last segment
    const childName = parts[parts.length - 1];
    // The parent prefix is everything except the last segment
    const parentPrefix = parts.slice(0, -1).join(".");

    const member: StdlibMember = {
      name: childName,
      fqn,
      signature: entry.signature,
      kind: inferStdlibKind(entry.signature),
    };

    const existing = map.get(parentPrefix);
    if (existing) {
      existing.push(member);
    } else {
      map.set(parentPrefix, [member]);
    }
  }

  return map;
}

export function getStdlibChildrenMap(
  stdlibIndex: Record<string, StdlibEntry>,
): Map<string, StdlibMember[]> {
  if (!stdlibChildrenMap) {
    stdlibChildrenMap = buildStdlibChildrenMap(stdlibIndex);
  }
  return stdlibChildrenMap;
}

/**
 * Get top-level stdlib module names (first segment after predef.).
 */
export function getStdlibTopLevel(
  stdlibIndex: Record<string, StdlibEntry>,
): { name: string; kind: CompletionItemKind }[] {
  if (!stdlibTopLevelNames) {
    const names = new Map<string, CompletionItemKind>();
    for (const fqn of Object.keys(stdlibIndex)) {
      const parts = fqn.split(".");
      if (parts.length < 2 || parts[0] !== "predef") continue;
      const mod = parts[1];
      if (!names.has(mod)) {
        const entry = stdlibIndex[fqn];
        names.set(mod, inferStdlibKind(entry.signature));
      }
    }
    stdlibTopLevelNames = [...names.entries()].map(([name, kind]) => ({ name, kind }));
  }
  return stdlibTopLevelNames;
}

// ---------------------------------------------------------------------------
// Auto-import reverse index — unqualified name → modules providing it
// ---------------------------------------------------------------------------

interface AutoImportEntry {
  /** Unqualified symbol name (e.g. "write"). */
  name: string;
  /** Top-level module providing it (e.g. "Stdio"). */
  module: string;
  /** CompletionItemKind inferred from signature. */
  kind: CompletionItemKind;
  /** Signature from stdlib index. */
  signature: string;
}

let autoImportMap: Map<string, AutoImportEntry[]> | null = null;
/** Sorted keys for O(log n) prefix lookup. Built alongside autoImportMap. */
let autoImportSortedKeys: string[] | null = null;

/**
 * Build the reverse index: unqualified symbol name → modules that provide it.
 *
 * Only indexes symbols from top-level modules (second segment in the FQN).
 * Deeply nested class members are excluded — they require qualified access
 * anyway and auto-importing the parent module wouldn't bring them into scope.
 */
function buildAutoImportMap(
  stdlibIndex: Record<string, StdlibEntry>,
): Map<string, AutoImportEntry[]> {
  const map = new Map<string, AutoImportEntry[]>();

  for (const [fqn, entry] of Object.entries(stdlibIndex)) {
    const parts = fqn.split(".");
    // Need at least: predef.Module.Symbol (3 segments)
    if (parts.length < 3 || parts[0] !== "predef") continue;

    const moduleName = parts[1];
    const symbolName = parts[parts.length - 1];

    // Skip operator identifiers and private symbols
    if (!isCompletableIdentifier(symbolName)) continue;
    if (symbolName.startsWith("_")) continue;

    const autoEntry: AutoImportEntry = {
      name: symbolName,
      module: moduleName,
      kind: inferStdlibKind(entry.signature),
      signature: entry.signature,
    };

    const existing = map.get(symbolName);
    if (existing) {
      // Avoid duplicates from the same module
      if (!existing.some(e => e.module === moduleName)) {
        existing.push(autoEntry);
      }
    } else {
      map.set(symbolName, [autoEntry]);
    }
  }

  return map;
}

/**
 * Get all auto-import entries from the stdlib index.
 * Used by completion to filter by prefix and add auto-import suggestions.
 */
export function getAllAutoImportEntries(
  stdlibIndex: Record<string, StdlibEntry>,
): Map<string, AutoImportEntry[]> {
  if (!autoImportMap) {
    autoImportMap = buildAutoImportMap(stdlibIndex);
    autoImportSortedKeys = [...autoImportMap.keys()].sort();
  }
  return autoImportMap;
}

/**
 * Get auto-import entries matching a case-insensitive prefix.
 * Uses binary search for O(log n + k) performance instead of scanning
 * the full map. Returns entries in sorted order.
 */
export function getAutoImportByPrefix(
  stdlibIndex: Record<string, StdlibEntry>,
  prefixLower: string,
): Array<[string, AutoImportEntry[]]> {
  const map = getAllAutoImportEntries(stdlibIndex);
  const keys = autoImportSortedKeys!;

  // Binary search for the first key that is >= prefixLower.
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid].toLowerCase().localeCompare(prefixLower) < 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  // Collect consecutive keys that start with the prefix.
  const results: Array<[string, AutoImportEntry[]]> = [];
  for (let i = lo; i < keys.length; i++) {
    if (!keys[i].toLowerCase().startsWith(prefixLower)) break;
    const entries = map.get(keys[i]);
    if (entries) {
      results.push([keys[i], entries]);
    }
  }
  return results;
}

/**
 * Reset the auto-import index. Called when the stdlib index is rebuilt.
 */
export function resetAutoImportCache(): void {
  autoImportMap = null;
  autoImportSortedKeys = null;
}

/**
 * Reset the stdlib children/top-level caches.
 */
export function resetStdlibCache(): void {
  stdlibChildrenMap = null;
  stdlibTopLevelNames = null;
  stdlibNameReverseIndex = null;
}

// ---------------------------------------------------------------------------
// Name-based reverse index for O(1) call-args lookup (C4)
// ---------------------------------------------------------------------------

/** Map from unqualified name → all stdlib entries with that last-segment name. */
let stdlibNameReverseIndex: Map<string, Array<{ fqn: string; entry: StdlibEntry }>> | null = null;

/**
 * Build a reverse index: unqualified symbol name → stdlib entries.
 * Used by call-args completion for O(1) lookup instead of linear scan.
 */
function buildNameReverseIndex(
  stdlibIndex: Record<string, StdlibEntry>,
): Map<string, Array<{ fqn: string; entry: StdlibEntry }>> {
  const map = new Map<string, Array<{ fqn: string; entry: StdlibEntry }>>();
  for (const [fqn, entry] of Object.entries(stdlibIndex)) {
    const parts = fqn.split(".");
    if (parts.length < 2 || parts[0] !== "predef") continue;
    const lastName = parts[parts.length - 1];
    const existing = map.get(lastName);
    const record = { fqn, entry };
    if (existing) {
      existing.push(record);
    } else {
      map.set(lastName, [record]);
    }
  }
  return map;
}

/**
 * Look up stdlib entries by unqualified name (O(1)).
 * Returns all matching entries or undefined if not found.
 */
export function getStdlibEntriesByName(
  stdlibIndex: Record<string, StdlibEntry>,
  name: string,
): Array<{ fqn: string; entry: StdlibEntry }> | undefined {
  if (!stdlibNameReverseIndex) {
    stdlibNameReverseIndex = buildNameReverseIndex(stdlibIndex);
  }
  return stdlibNameReverseIndex.get(name);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Infer CompletionItemKind from a stdlib signature string.
 */
function inferStdlibKind(signature: string): CompletionItemKind {
  if (signature.startsWith("inherit ")) return CompletionItemKind.Class;
  if (signature.includes("(")) return CompletionItemKind.Method;
  if (/^(constant|final)\s/.test(signature)) return CompletionItemKind.Constant;
  return CompletionItemKind.Variable;
}

/**
 * Check if a name is a valid completable identifier (not an operator).
 * Filters out Pike backtick identifiers and operators like `>`, `==`, `->`, etc.
 */
export function isCompletableIdentifier(name: string): boolean {
  // Skip backtick identifiers (operators like `->`, `+`, `[]`)
  if (name.startsWith("`")) return false;
  // Skip pure operator tokens
  if (/^[<>!=&|^~%/*+\-]+$/.test(name)) return false;
  // Skip bracket-like tokens
  if (/^[\[\](){}]+$/.test(name)) return false;
  // Must start with a letter or underscore
  if (!/^[a-zA-Z_]/.test(name)) return false;
  return true;
}
