/**
 * Roxen-specific resolution: the `roxen-module://` scheme, and folding Roxen's
 * search paths into Pike's.
 *
 * The design decision this file implements is that Roxen introduces exactly one
 * genuinely new resolution concept — the `roxen-module://` URI — and nothing
 * else. Roxen's include, module, and program directories are ordinary search
 * paths, so they are merged into `PikePaths` and resolved by the existing
 * resolver rather than by a parallel Roxen path. That keeps `ModuleResolver`
 * single-purpose, and means Roxen inherits resolver fixes for free.
 */

import { join } from "node:path";
import { readdir, open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { PikePaths } from "./pikeDetection";
import type { RoxenPaths } from "./roxenDetection";

/** The URI scheme Roxen sources use to inherit across modules. */
export const ROXEN_MODULE_SCHEME = "roxen-module://";

/**
 * A second scheme Roxen's master understands. It expands `$SERVERDIR`-style
 * variables through a function that only exists inside a running Roxen, so
 * there is nothing to resolve statically. Recognised here purely so that
 * callers can tell "a Roxen URI we deliberately leave alone" from "a filename
 * that happens to contain a colon".
 */
export const ROXEN_PATH_SCHEME = "roxen-path://";

// ---------------------------------------------------------------------------
// Path merging
// ---------------------------------------------------------------------------

/** De-duplicate a path list, preserving first-seen order. */
function dedupe(paths: string[]): string[] {
  return [...new Set(paths)];
}

/**
 * Fold Roxen's search paths into Pike's.
 *
 * Roxen's paths are appended, not prepended: a workspace file must still
 * shadow an installation file of the same name, exactly as it does for Pike's
 * own system paths. Within the Roxen block, Roxen's own ordering is preserved,
 * so a populated `local/` tree shadows the stock one as Roxen intends.
 *
 * `pikeHome` is left alone. It is the boundary check's anchor for Pike's own
 * tree; Roxen's tree is admitted by appearing in the path lists, which the
 * boundary check also consults.
 */
export function mergeRoxenIntoPikePaths(pikePaths: PikePaths, roxenPaths: RoxenPaths): PikePaths {
  return {
    ...pikePaths,
    modulePaths: dedupe([...pikePaths.modulePaths, ...roxenPaths.modulePaths]),
    includePaths: dedupe([...pikePaths.includePaths, ...roxenPaths.includePaths]),
    programPaths: dedupe([...pikePaths.programPaths, ...roxenPaths.programPaths]),
  };
}

// ---------------------------------------------------------------------------
// The roxen-module:// scheme
// ---------------------------------------------------------------------------

/**
 * Directory names Roxen never descends into when hunting for a module.
 * Taken from `module_support.pike`'s `nomods` set.
 */
const SKIP_DIRS: ReadonlySet<string> = new Set([
  "pike-modules", "CVS", ".svn", ".git", "node_modules",
]);

/** Extensions that make a file a Roxen module. */
const MODULE_EXTENSIONS = [".pike", ".so"] as const;

/** Marker files that make Roxen skip a directory entirely. */
const NOMODULES_MARKERS = [".nomodules", ".no_modules"] as const;

/**
 * Bound on how deep the module scan descends.
 *
 * Roxen's own scan is unbounded, but it runs once at server start against a
 * tree it controls. This one runs on a resolution request against whatever the
 * user pointed at, so it gets a limit. The real `server/modules` tree is four
 * levels deep.
 */
const MAX_SCAN_DEPTH = 8;

/** True when `path` names the Roxen module `name` (basename, module extension). */
function isModuleFile(fileName: string, name: string): boolean {
  // Roxen skips editor leftovers by last character, and anything under 3 chars.
  if (fileName.length < 3) return false;
  if (fileName.endsWith("~") || fileName.endsWith("#")) return false;
  for (const ext of MODULE_EXTENSIONS) {
    if (fileName === `${name}${ext}`) return true;
  }
  return false;
}

/**
 * Roxen refuses to treat a file whose first four bytes are `#!NO` as a module.
 * The corpus uses this to park disabled modules in the tree, so honouring it
 * keeps resolution from landing on a file Roxen itself would never load.
 */
async function isDisabledModule(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "r");
    const buf = Buffer.alloc(4);
    const { bytesRead } = await handle.read(buf, 0, 4, 0);
    return bytesRead === 4 && buf.toString("latin1") === "#!NO";
  } catch {
    return false; // Unreadable: let the caller fail on it rather than skip it silently.
  } finally {
    await handle?.close();
  }
}

/** Recursive scan of one module directory. Returns the first match, or null. */
async function scanForModule(dir: string, name: string, depth: number): Promise<string | null> {
  if (depth > MAX_SCAN_DEPTH) return null;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const names = new Set(entries.map((e) => e.name));
  for (const marker of NOMODULES_MARKERS) {
    if (names.has(marker)) return null;
  }

  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) subdirs.push(join(dir, entry.name));
      continue;
    }
    if (!isModuleFile(entry.name, name)) continue;
    const full = join(dir, entry.name);
    if (await isDisabledModule(full)) continue;
    return full;
  }

  // Breadth before depth, so a module in the directory itself wins over one
  // buried below it — matching Roxen, which collects per-directory.
  for (const subdir of subdirs) {
    const found = await scanForModule(subdir, name, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Resolve `roxen-module://<name>` to a file URI.
 *
 * Roxen resolves this through `find_module`, which scans its `ModuleDirs`
 * recursively for a file whose basename (without extension) equals the name
 * and whose extension marks it a module. This reproduces that scan over the
 * detected installation's module directories.
 *
 * Returns null when no installation was detected or the module is not in it.
 * That is not an error: a `roxen-module://` inherit in a workspace with no
 * Roxen must stay quietly unresolved rather than turn the file red.
 */
export async function resolveRoxenModuleUri(
  moduleDirs: readonly string[],
  target: string,
): Promise<string | null> {
  const name = target.startsWith(ROXEN_MODULE_SCHEME)
    ? target.slice(ROXEN_MODULE_SCHEME.length)
    : target;
  // A name with a path separator is not a module name; Roxen indexes by
  // basename alone, and admitting a separator here would turn the scheme into
  // an unbounded filesystem read.
  if (!name || name.includes("/") || name.includes("\\")) return null;

  for (const dir of moduleDirs) {
    const found = await scanForModule(dir, name, 0);
    if (found) return pathToFileURL(found).href;
  }
  return null;
}

/** True when an inherit target is a Roxen URI this module knows about. */
export function isRoxenScheme(target: string): boolean {
  return target.startsWith(ROXEN_MODULE_SCHEME) || target.startsWith(ROXEN_PATH_SCHEME);
}

/**
 * Resolve a Roxen-scheme `inherit` target to a file URI, or null.
 *
 * Null covers three cases that are all correct outcomes rather than errors: a
 * `roxen-path://` URI (only a running Roxen can expand it), a module that no
 * detected installation contains, and no installation at all.
 */
export function resolveRoxenInherit(
  moduleDirs: readonly string[],
  target: string,
): Promise<string | null> {
  if (!target.startsWith(ROXEN_MODULE_SCHEME)) return Promise.resolve(null);
  return resolveRoxenModuleUri(moduleDirs, target);
}
