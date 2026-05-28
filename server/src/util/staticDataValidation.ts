/**
 * Runtime validation for static JSON data files imported at startup.
 *
 * These JSON files are bundled with the server (not user-generated), but a
 * corrupted build or bad checkout could produce malformed data. We validate
 * a sample of entries at startup — if the shape looks wrong, we log a warning
 * and fall back to an empty default so the server keeps running with degraded
 * functionality.
 *
 * TigerStyle: fail-safe, explicit, no hidden assumptions.
 */

import type { Connection } from "vscode-languageserver/node";
import { logWarn } from "./errorLog.js";

// ---------------------------------------------------------------------------
// Types for validated data
// ---------------------------------------------------------------------------

export interface StdlibAutodocEntry {
  signature: string;
  markdown: string;
}

export interface PredefAutodocEntry {
  signature: string;
  markdown: string;
  params?: Array<{ name: string; type: string }>;
  returnType?: string;
}

export type StdlibAutodocIndex = Record<string, StdlibAutodocEntry>;
export type PredefBuiltinIndex = Record<string, string>;
export type PredefAutodocIndex = Record<string, PredefAutodocEntry>;

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

/**
 * Validate that `data` looks like a Record<string, { signature: string; markdown: string }>.
 *
 * Checks that:
 *  - data is a non-null object
 *  - it has at least one key (sanity check for non-empty data)
 *  - the first few entries have the expected nested shape
 *
 * Returns the typed data if valid, or `null` if validation fails.
 */
export function validateStdlibAutodocIndex(data: unknown): StdlibAutodocIndex | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }

  const obj = data as Record<string, unknown>;
  const keys = Object.keys(obj);

  // Empty is technically valid but unusual; check a sample of entries
  const sampleSize = Math.min(keys.length, 5);
  for (let i = 0; i < sampleSize; i++) {
    const entry = obj[keys[i]];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const rec = entry as Record<string, unknown>;
    if (typeof rec["signature"] !== "string") return null;
    if (typeof rec["markdown"] !== "string") return null;
  }

  return obj as unknown as StdlibAutodocIndex;
}

/**
 * Validate that `data` looks like a Record<string, string>.
 *
 * Checks that:
 *  - data is a non-null object
 *  - the first few values are strings
 *
 * Returns the typed data if valid, or `null` if validation fails.
 */
export function validatePredefBuiltinIndex(data: unknown): PredefBuiltinIndex | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }

  const obj = data as Record<string, unknown>;
  const keys = Object.keys(obj);

  const sampleSize = Math.min(keys.length, 5);
  for (let i = 0; i < sampleSize; i++) {
    if (typeof obj[keys[i]] !== "string") {
      return null;
    }
  }

  return obj as unknown as PredefBuiltinIndex;
}

/**
 * Validate that `data` looks like a Record<string, PredefAutodocEntry>.
 *
 * Checks that:
 *  - data is a non-null object
 *  - the first few entries have `signature` (string) and `markdown` (string)
 *
 * Returns the typed data if valid, or `null` if validation fails.
 */
export function validatePredefAutodocIndex(data: unknown): PredefAutodocIndex | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }

  const obj = data as Record<string, unknown>;
  const keys = Object.keys(obj);

  const sampleSize = Math.min(keys.length, 5);
  for (let i = 0; i < sampleSize; i++) {
    const entry = obj[keys[i]];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return null;
    }
    const rec = entry as Record<string, unknown>;
    if (typeof rec["signature"] !== "string") return null;
    if (typeof rec["markdown"] !== "string") return null;
  }

  return obj as unknown as PredefAutodocIndex;
}

// ---------------------------------------------------------------------------
// Startup helpers
// ---------------------------------------------------------------------------

const EMPTY_STDLIB: StdlibAutodocIndex = {};
const EMPTY_PREDEF: PredefBuiltinIndex = {};
const EMPTY_PREDEF_AUTODOC: PredefAutodocIndex = {};

/**
 * Validate and return the stdlib autodoc index.
 * Logs a warning and returns an empty default on failure.
 */
export function loadStdlibAutodocIndex(
  raw: unknown,
  connection: Connection,
): StdlibAutodocIndex {
  const validated = validateStdlibAutodocIndex(raw);
  if (validated !== null) return validated;

  logWarn(
    connection,
    "stdlib-autodoc.json validation failed — hover/completion data will be unavailable",
  );
  return EMPTY_STDLIB;
}

/**
 * Validate and return the predef builtin index.
 * Logs a warning and returns an empty default on failure.
 */
export function loadPredefBuiltinIndex(
  raw: unknown,
  connection: Connection,
): PredefBuiltinIndex {
  const validated = validatePredefBuiltinIndex(raw);
  if (validated !== null) return validated;

  logWarn(
    connection,
    "predef-builtin-index.json validation failed — rename protection will be incomplete",
  );
  return EMPTY_PREDEF;
}

/**
 * Validate and return the predef autodoc index.
 * Logs a warning and returns an empty default on failure.
 */
export function loadPredefAutodocIndex(
  raw: unknown,
  connection: Connection,
): PredefAutodocIndex {
  const validated = validatePredefAutodocIndex(raw);
  if (validated !== null) return validated;

  logWarn(
    connection,
    "predef-autodoc.json validation failed — predef documentation will be unavailable",
  );
  return EMPTY_PREDEF_AUTODOC;
}

/**
 * Validate stdlib autodoc index without a connection (for use in modules
 * that don't have direct access to the connection). Logs to console.warn.
 */
export function validateStdlibAutodocIndexOrEmpty(raw: unknown): StdlibAutodocIndex {
  const validated = validateStdlibAutodocIndex(raw);
  if (validated !== null) return validated;

  console.warn(
    "[pike-lsp] stdlib-autodoc.json validation failed — rename protection will be incomplete",
  );
  return EMPTY_STDLIB;
}

/**
 * Validate predef builtin index without a connection (for use in modules
 * that don't have direct access to the connection). Logs to console.warn.
 */
export function validatePredefBuiltinIndexOrEmpty(raw: unknown): PredefBuiltinIndex {
  const validated = validatePredefBuiltinIndex(raw);
  if (validated !== null) return validated;

  console.warn(
    "[pike-lsp] predef-builtin-index.json validation failed — rename protection will be incomplete",
  );
  return EMPTY_PREDEF;
}
