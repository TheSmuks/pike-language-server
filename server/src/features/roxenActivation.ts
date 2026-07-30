/**
 * Roxen mode activation: deciding which files are Roxen files.
 *
 * Roxen symbols must reach Roxen files and no others. A workspace-level switch
 * would force a mixed repository to choose between a red Roxen module and a
 * polluted Pike namespace, so activation is a per-file property.
 *
 * Three tiers, in order:
 *
 *   1. The `pike.roxen.mode` setting, when it is `on` or `off`.
 *   2. A marker in the file itself. The three marker families below were
 *      measured against the Roxen 6.1 corpus, not assumed: together they cover
 *      143 of the 170 Pike files in `server/modules/`.
 *   3. Where the file sits. The remaining 27 corpus files are
 *      `graphics/rimage/plugins/*.pike` — helpers that are Roxen files by
 *      virtue of location, not content. A fourth marker family would have to
 *      match on something incidental to catch them, and would then misfire on
 *      plain Pike; inheriting from the directory addresses them for the right
 *      reason.
 */

import { dirname, join, relative, isAbsolute } from "node:path";
import { readdir, open } from "node:fs/promises";
import { decodeSource } from "../util/sourceDecoder";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The `pike.roxen.mode` setting. */
export type RoxenMode = "auto" | "on" | "off";

export const DEFAULT_ROXEN_MODE: RoxenMode = "auto";

export function isRoxenMode(value: unknown): value is RoxenMode {
  return value === "auto" || value === "on" || value === "off";
}

export interface RoxenActivationContext {
  mode: RoxenMode;
  /** Root of a detected installation, or null. Files inside one are Roxen files. */
  roxenHome: string | null;
  /** Workspace root — the ceiling for the directory-inheritance walk. */
  workspaceRoot: string;
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

/**
 * Headers whose inclusion marks a file as Roxen.
 *
 * Six of the thirteen Roxen headers, not all thirteen. The others
 * (`stat.h`, `variables.h`, `version.h`, …) have names generic enough that a
 * plain Pike project could plausibly own one, and every corpus file that
 * includes one of those also includes one of these.
 */
export const ROXEN_ACTIVATION_HEADERS: readonly string[] = [
  "module.h",
  "roxen.h",
  "config.h",
  "module_constants.h",
  "request_trace.h",
  "config_interface.h",
];

/**
 * `#include <module.h>` and friends. Roxen writes these with angle brackets;
 * quotes are accepted too, since an include is an include and the header names
 * are what carry the signal.
 *
 * `#` may be followed by whitespace — `# include <request_trace.h>` appears in
 * the corpus (`modules/security/htaccess.pike`) and must not be missed.
 */
const INCLUDE_MARKER = new RegExp(
  String.raw`^[ \t]*#[ \t]*include[ \t]*[<"](?:${ROXEN_ACTIVATION_HEADERS.join("|").replace(/\./g, "\\.")})[>"]`,
  "m",
);

/** `inherit "module";` — the Roxen module prototype. */
const INHERIT_MARKER = /^[ \t]*inherit[ \t]+"module"[ \t]*;/m;

/** `constant module_type = MODULE_LOCATION;` and the rest of the taxonomy. */
const MODULE_TYPE_MARKER = /^[ \t]*constant[ \t]+module_type[ \t]*=[^;]*\bMODULE_[A-Z_]+/m;

/**
 * True when the source carries one of the measured Roxen markers.
 *
 * Matching is line-anchored but not comment-aware. A commented-out
 * `#include <module.h>` therefore activates Roxen mode. That is the deliberate
 * trade: the cost of a false positive is some extra completions in a file that
 * was, by the evidence of its own text, Roxen code at some point; the cost of
 * a comment-aware scan is re-implementing the tokenizer here, on every file,
 * for a case the corpus does not contain.
 */
export function hasRoxenMarker(source: string): boolean {
  return INCLUDE_MARKER.test(source)
    || INHERIT_MARKER.test(source)
    || MODULE_TYPE_MARKER.test(source);
}

// ---------------------------------------------------------------------------
// Directory inheritance
// ---------------------------------------------------------------------------

/** How much of a neighbouring file to read when looking for a marker. */
const MARKER_SCAN_BYTES = 8192;

/** How many files to examine in one directory before giving up on it. */
const MAX_FILES_PER_DIR = 128;

/** Ceiling on the ancestor walk, independent of the workspace-root check. */
const MAX_ANCESTOR_DEPTH = 32;

/**
 * Per-directory memo of "does this directory contain a marked file".
 *
 * Directory inheritance would otherwise re-read every sibling of every file on
 * every activation query. Cleared by `clearRoxenActivationCache` when files
 * change, since a directory's answer flips when a marked file is added or
 * removed.
 */
const directoryMarkerCache = new Map<string, boolean>();

/** Drop the directory-inheritance memo. */
export function clearRoxenActivationCache(): void {
  directoryMarkerCache.clear();
}

/** Read the head of a file and decode it by detected encoding. */
async function readHead(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
    const buf = Buffer.alloc(MARKER_SCAN_BYTES);
    const { bytesRead } = await handle.read(buf, 0, MARKER_SCAN_BYTES, 0);
    // Decoded, not read as UTF-8: over half the Roxen corpus is ISO-8859-1,
    // and a mis-decode here silently loses markers.
    return decodeSource(buf.subarray(0, bytesRead)).text;
  } catch {
    return "";
  } finally {
    await handle?.close();
  }
}

/** True when any Pike file directly in `dir` carries a marker. */
async function directoryHasMarkedFile(dir: string): Promise<boolean> {
  const cached = directoryMarkerCache.get(dir);
  if (cached !== undefined) return cached;

  let result = false;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    let examined = 0;
    for (const entry of entries) {
      if (examined >= MAX_FILES_PER_DIR) break;
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".pike") && !entry.name.endsWith(".pmod")) continue;
      examined++;
      if (hasRoxenMarker(await readHead(join(dir, entry.name)))) {
        result = true;
        break;
      }
    }
  } catch {
    result = false; // Unreadable directory tells us nothing; treat as unmarked.
  }

  directoryMarkerCache.set(dir, result);
  return result;
}

/** True when `child` is inside `parent` (or is `parent`). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Walk from the file's own directory up to the workspace root, looking for a
 * directory that contains a marked file.
 *
 * The walk stops at the workspace root rather than the filesystem root: a
 * marked file two directories above the project is not evidence about this
 * project, and continuing would let one Roxen checkout anywhere on the path
 * turn every unrelated workspace into a Roxen one.
 */
async function inheritsFromDirectory(filePath: string, workspaceRoot: string): Promise<boolean> {
  let dir = dirname(filePath);
  if (!isInside(workspaceRoot, dir)) return false;

  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (await directoryHasMarkedFile(dir)) return true;
    if (dir === workspaceRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    if (!isInside(workspaceRoot, parent)) break;
    dir = parent;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Decide whether a file is a Roxen file.
 *
 * `source` is the file's text when the caller already has it (an open
 * document); pass null to have the head read from disk.
 *
 * Never throws. An unreadable file is simply not a Roxen file.
 */
export async function isRoxenFile(
  filePath: string,
  source: string | null,
  ctx: RoxenActivationContext,
): Promise<boolean> {
  if (ctx.mode === "off") return false;
  if (ctx.mode === "on") return true;

  const text = source ?? (await readHead(filePath));
  if (hasRoxenMarker(text)) return true;

  // Anything inside a detected installation is Roxen code by definition, and
  // this is checked before the directory walk because it needs no I/O.
  if (ctx.roxenHome && isInside(ctx.roxenHome, filePath)) return true;

  return inheritsFromDirectory(filePath, ctx.workspaceRoot);
}
