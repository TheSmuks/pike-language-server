/**
 * Roxen installation discovery.
 *
 * Roxen source is ordinary Pike compiled in a non-ordinary environment: the
 * module loader supplies include paths, a module prototype to inherit, and a
 * large constant vocabulary. This module locates a local Roxen tree and derives
 * those paths in the same shape `pikeDetection.ts` produces for Pike, so that
 * `ModuleResolver` needs no Roxen-specific resolution concepts.
 *
 * The path derivation is not invented here. It mirrors what Roxen's own
 * `server/start` assembles into the `-M`/`-I`/`-P` arguments it hands to Pike,
 * read off Roxen 6.1 (`rxnpatch/6.1` at 4f1d04f8) and confirmed against the
 * arguments a running server prints. Directories Roxen only adds when they
 * exist are only added here when they exist, for the same reason: an absent
 * `local/` tree must not put a phantom entry on the search path.
 *
 * Detection is an enhancement, never a dependency — absence is a normal,
 * non-error outcome (see `roxenIndex.ts` for what still works without it).
 */

import { join, dirname, parse as parsePath } from "node:path";
import { readdir, readFile, stat } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoxenPaths {
  /** Installation root — the directory holding `server/` (e.g. "/usr/local/roxen6"). */
  roxenHome: string;
  /** Version as declared by `server/etc/include/version.h` (e.g. "6.1.248"). */
  version: string;
  /** Module search paths (-M), in Roxen's own order. */
  modulePaths: string[];
  /** Include search paths (-I), in Roxen's own order. */
  includePaths: string[];
  /** Program search paths (-P), in Roxen's own order. */
  programPaths: string[];
  /**
   * Directories holding Roxen *modules* — the things `roxen-module://` names.
   *
   * Distinct from `modulePaths`, which are Pike module search paths. Roxen's
   * own default for its `ModuleDirs` variable is `$LOCALDIR/modules/` then
   * `modules/`, searched in order, and a module is found by scanning them
   * recursively for a file whose basename matches.
   */
  moduleDirs: string[];
}

export interface RoxenDetectionResult {
  /** The located installation, or null when none was found. */
  paths: RoxenPaths | null;
  /**
   * How `paths` was found. Present even when `paths` is null (as "absent"), so
   * a caller can tell "no Roxen here" from "found via the ancestor scan".
   */
  source: "explicit" | "pike_json" | "workspace_ancestor" | "filesystem" | "absent";
  /**
   * Set when a path was configured explicitly (by setting or by `pike.json`)
   * but held no Roxen tree. Detection continues down the precedence order —
   * a typo must not disable Roxen support outright — but the caller is
   * expected to surface this rather than let it fail silently.
   */
  misconfiguredPath?: string;
}

/** User-supplied overrides, from LSP settings or initialization options. */
export interface RoxenDetectionOptions {
  /** An explicit installation path. Highest precedence. */
  explicitPath?: string;
  /**
   * Where the filesystem-discovery step looks. Defaults to `DISCOVERY_ROOTS`.
   * Overridden only so discovery can be exercised against a directory the
   * caller owns; production never sets it.
   */
  discoveryRoots?: readonly DiscoveryRoot[];
}

// ---------------------------------------------------------------------------
// Recognising a Roxen tree
// ---------------------------------------------------------------------------

/**
 * Files that must all be present for a directory to be a Roxen installation.
 *
 * Two markers rather than one: `server/base_server/roxen.pike` alone is
 * satisfied by a source checkout of something unrelated named roxen.pike, and
 * `server/etc/include/module.h` alone is satisfied by any project with an
 * `etc/include`. Together they are specific to Roxen, and both are needed
 * anyway — the second is the include directory the whole feature exists to put
 * on the search path.
 */
const ROXEN_MARKERS = [
  join("server", "base_server", "roxen.pike"),
  join("server", "etc", "include", "module.h"),
] as const;

/** A place `filesystem` discovery looks: a directory plus a name prefix. */
export interface DiscoveryRoot {
  dir: string;
  prefix: string;
}

/** Where `filesystem` discovery looks by default. */
export const DISCOVERY_ROOTS: readonly DiscoveryRoot[] = [{ dir: "/usr/local", prefix: "roxen" }];

/** Bound on how far the workspace-ancestor scan walks up. */
const MAX_ANCESTOR_DEPTH = 32;

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function isDir(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

/** True when `dir` is the root of a Roxen installation. */
export async function isRoxenTree(dir: string): Promise<boolean> {
  for (const marker of ROXEN_MARKERS) {
    if (!(await pathExists(join(dir, marker)))) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

const ROXEN_VER_RE = /constant\s+roxen_ver\s*=\s*"([^"]+)"/;
const ROXEN_BUILD_RE = /constant\s+roxen_build\s*=\s*"([^"]+)"/;

/**
 * Read the version from `server/etc/include/version.h`.
 *
 * Roxen declares `roxen_ver` ("6.1") and `roxen_build` ("248") there as plain
 * string constants, so this needs neither a running server nor a Pike
 * subprocess. Returns "0" when the file is unreadable or unrecognised, which
 * sorts below any real version rather than winning by accident.
 */
export async function readRoxenVersion(roxenHome: string): Promise<string> {
  try {
    // version.h is ASCII in every Roxen release; latin1 reads it byte-identically
    // and cannot throw on high bytes the way a strict UTF-8 decode would.
    const text = (await readFile(join(roxenHome, "server", "etc", "include", "version.h"))).toString("latin1");
    const ver = ROXEN_VER_RE.exec(text)?.[1];
    if (!ver) return "0";
    const build = ROXEN_BUILD_RE.exec(text)?.[1];
    return build ? `${ver}.${build}` : ver;
  } catch {
    return "0";
  }
}

/** Order two version strings numerically per component; higher sorts first. */
function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.parseInt(pa[i] ?? "0", 10) || 0;
    const nb = Number.parseInt(pb[i] ?? "0", 10) || 0;
    if (na !== nb) return nb - na;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Path derivation
// ---------------------------------------------------------------------------

/** Append `dir` to `list` when it exists, mirroring Roxen's own conditionals. */
async function pushIfDir(list: string[], dir: string): Promise<void> {
  if (await isDir(dir)) list.push(dir);
}

/**
 * Derive Roxen's module, include, and program search paths.
 *
 * Order matters and is Roxen's, not ours: the first match wins in resolution,
 * and a Roxen installation with a populated `local/` tree deliberately shadows
 * parts of the stock one.
 */
export async function deriveRoxenPaths(roxenHome: string): Promise<RoxenPaths> {
  const server = join(roxenHome, "server");
  const local = join(roxenHome, "local");

  const modulePaths: string[] = [];
  // Roxen calls this a kludge in its own start script and adds it first.
  await pushIfDir(modulePaths, join(server, "modules", "feedimport", "pike_modules"));
  modulePaths.push(join(server, "etc", "modules"));
  await pushIfDir(modulePaths, join(local, "pike_modules"));
  await pushIfDir(modulePaths, join(local, "etc", "modules"));

  const includePaths: string[] = [join(server, "etc", "include")];
  await pushIfDir(includePaths, join(local, "include"));
  includePaths.push(join(server, "base_server"));
  await pushIfDir(includePaths, join(local, "base_server"));
  await pushIfDir(includePaths, join(local, "etc", "include"));

  const programPaths: string[] = [join(server, "base_server")];
  await pushIfDir(programPaths, join(local, "base_server"));
  programPaths.push(server);
  await pushIfDir(programPaths, join(local, "etc"));

  // Roxen's own ModuleDirs default, in its order: local overrides stock.
  const moduleDirs: string[] = [];
  await pushIfDir(moduleDirs, join(local, "modules"));
  moduleDirs.push(join(server, "modules"));

  return {
    roxenHome,
    version: await readRoxenVersion(roxenHome),
    modulePaths,
    includePaths,
    programPaths,
    moduleDirs,
  };
}

// ---------------------------------------------------------------------------
// The four sources, in precedence order
// ---------------------------------------------------------------------------

/** Read a `roxen` path declaration from the workspace's `pike.json`. */
async function readPikeJsonRoxenPath(workspaceRoot: string): Promise<string | null> {
  try {
    const text = (await readFile(join(workspaceRoot, "pike.json"))).toString("utf-8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return null;
    const roxen = (parsed as Record<string, unknown>)["roxen"];
    if (typeof roxen === "string" && roxen.length > 0) return roxen;
    if (typeof roxen === "object" && roxen !== null) {
      const path = (roxen as Record<string, unknown>)["path"];
      if (typeof path === "string" && path.length > 0) return path;
    }
    return null;
  } catch {
    // Absent or malformed pike.json is not an error — it is the common case.
    return null;
  }
}

/**
 * Walk up from the workspace root looking for an enclosing Roxen tree.
 *
 * This is what catches the common case of editing modules in place inside an
 * installation, where nothing is configured because nothing needed to be.
 */
async function findAncestorRoxenTree(workspaceRoot: string): Promise<string | null> {
  let dir = workspaceRoot;
  for (let depth = 0; depth < MAX_ANCESTOR_DEPTH; depth++) {
    if (await isRoxenTree(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // Reached the filesystem root.
    dir = parent;
  }
  return null;
}

/**
 * Scan install locations for Roxen trees and return the highest-versioned one.
 *
 * Roxen installs conventionally land at `/usr/local/roxen<major>`, so several
 * major versions commonly coexist. `roots` defaults to those locations and is a
 * parameter so this can be exercised against a directory a test actually owns —
 * no test can stage two installations under `/usr/local`.
 *
 * Ties on version break on path, so the result is stable across runs rather
 * than dependent on directory-entry order.
 */
export async function discoverInstalledRoxen(
  roots: readonly DiscoveryRoot[] = DISCOVERY_ROOTS,
): Promise<string | null> {
  const candidates: { dir: string; version: string }[] = [];

  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root.dir, { withFileTypes: true });
    } catch {
      continue; // Missing or unreadable — nothing to discover here.
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (!entry.name.startsWith(root.prefix)) continue;
      const dir = join(root.dir, entry.name);
      if (!(await isRoxenTree(dir))) continue;
      candidates.push({ dir, version: await readRoxenVersion(dir) });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareVersionsDesc(a.version, b.version) || a.dir.localeCompare(b.dir));
  return candidates[0]!.dir;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Locate a Roxen installation and derive its search paths.
 *
 * Precedence: an explicit setting, then the workspace's `pike.json`, then an
 * ancestor of the workspace root, then filesystem discovery. The first source
 * that yields a real Roxen tree wins.
 *
 * A configured path that holds no Roxen tree does not stop the search — it is
 * reported via `misconfiguredPath` and the next source is tried, so a stale
 * setting degrades to auto-detection instead of disabling the feature.
 *
 * This never throws. "No Roxen installed" is the expected outcome on most
 * machines and must leave the server starting normally.
 */
export async function detectRoxenPaths(
  workspaceRoot: string,
  options?: RoxenDetectionOptions,
): Promise<RoxenDetectionResult> {
  let misconfiguredPath: string | undefined;

  const explicit = options?.explicitPath;
  if (explicit) {
    if (await isRoxenTree(explicit)) {
      return { paths: await deriveRoxenPaths(explicit), source: "explicit" };
    }
    misconfiguredPath = explicit;
  }

  const declared = await readPikeJsonRoxenPath(workspaceRoot);
  if (declared) {
    const resolved = parsePath(declared).root ? declared : join(workspaceRoot, declared);
    if (await isRoxenTree(resolved)) {
      return { paths: await deriveRoxenPaths(resolved), source: "pike_json", ...(misconfiguredPath ? { misconfiguredPath } : {}) };
    }
    misconfiguredPath ??= resolved;
  }

  const ancestor = await findAncestorRoxenTree(workspaceRoot);
  if (ancestor) {
    return { paths: await deriveRoxenPaths(ancestor), source: "workspace_ancestor", ...(misconfiguredPath ? { misconfiguredPath } : {}) };
  }

  const discovered = await discoverInstalledRoxen(options?.discoveryRoots);
  if (discovered) {
    return { paths: await deriveRoxenPaths(discovered), source: "filesystem", ...(misconfiguredPath ? { misconfiguredPath } : {}) };
  }

  return { paths: null, source: "absent", ...(misconfiguredPath ? { misconfiguredPath } : {}) };
}

// ---------------------------------------------------------------------------
// Lazy singleton, keyed on its inputs (mirrors getPikePaths)
// ---------------------------------------------------------------------------

let cachedKey = "";
let cachedPromise: Promise<RoxenDetectionResult> | null = null;

/**
 * Detection, cached in memory per unique set of inputs.
 *
 * Safe to call on every request: detection runs once, and re-runs only when the
 * workspace or the configured path changes.
 */
export function getRoxenPaths(
  workspaceRoot: string,
  options?: RoxenDetectionOptions,
): Promise<RoxenDetectionResult> {
  const key = `${workspaceRoot}\0${options?.explicitPath ?? ""}\0${JSON.stringify(options?.discoveryRoots ?? null)}`;
  if (key !== cachedKey || !cachedPromise) {
    cachedKey = key;
    cachedPromise = detectRoxenPaths(workspaceRoot, options);
  }
  return cachedPromise;
}

/** Drop the cached detection. Tests and configuration changes use this. */
export function clearRoxenPathsCache(): void {
  cachedKey = "";
  cachedPromise = null;
}
