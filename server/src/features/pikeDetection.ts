/**
 * Pike binary detection — path discovery from system.
 *
 * Extracted from moduleResolver.ts to keep it under 500 lines.
 * Re-exported by moduleResolver.ts so existing imports continue to work.
 */

import { join } from "node:path";
import { stat, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";

// ---------------------------------------------------------------------------
// Types (re-exported from moduleResolver.ts)
// ---------------------------------------------------------------------------

export interface PikePaths {
  /** Pike installation root (e.g., "/usr/local/pike/8.0.1116"). */
  pikeHome: string;
  /** Module search paths (-M). Includes system + workspace paths. */
  modulePaths: string[];
  /** Include search paths (-I). */
  includePaths: string[];
  /** Program search paths (for inherit string resolution). */
  programPaths: string[];
  /**
   * Default directory for native library loading (LD_LIBRARY_PATH).
   * Derived from pikeHome/lib when pikeHome is auto-detected.
   * Used as the fallback libraryPath for the Pike worker.
   */
  ldLibraryPath: string;
}

/**
 * User-supplied path overrides from VSCode settings.
 * When set, these bypass auto-detection entirely.
 */
export interface PikePathOverrides {
  pikeHome?: string;
  modulePaths?: string[];
  includePaths?: string[];
  programPaths?: string[];
}

// ---------------------------------------------------------------------------
// Async fs helpers
// ---------------------------------------------------------------------------

/** Check that a path exists on disk (file or directory). */
async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/** Check that a path exists and is a directory. */
async function isDir(p: string): Promise<boolean> {
  try { const s = await stat(p); return s.isDirectory(); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Promisified execFile
// ---------------------------------------------------------------------------

const execFileAsync = (
  cmd: string,
  args: string[],
  opts: { timeout: number }
): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { ...opts, encoding: "utf-8" }, (err: Error | null, stdout: string, stderr: string) => {
      if (err) { reject(err); return; }
      resolve(stdout + stderr);
    });
  });

// ---------------------------------------------------------------------------
// Detection phase helpers
// ---------------------------------------------------------------------------

/** Parsed result from `pike --show-paths` output. */
interface ShowPathsResult {
  pikeHome: string;
  systemModulePath: string;
  includePath: string;
  programPath: string;
}

/**
 * Phase 1: Parse `pike --show-paths` output to extract pikeHome and paths.
 */
async function queryShowPaths(pike: string): Promise<ShowPathsResult> {
  let pikeHome = "";
  let systemModulePath = "";
  let includePath = "";
  let programPath = "";

  try {
    const output = await execFileAsync(pike, ["--show-paths"], { timeout: 5000 });
    ({ pikeHome, systemModulePath, includePath, programPath } =
      parseShowPathsOutput(output));
  } catch {
    // Pike binary not found or failed — return empty
  }

  return { pikeHome, systemModulePath, includePath, programPath };
}

/**
 * Parse `pike --show-paths` stdout into structured paths.
 */
function parseShowPathsOutput(output: string): ShowPathsResult {
  let pikeHome = "";
  let systemModulePath = "";
  let includePath = "";
  let programPath = "";

  // Pike pads each label with dots to a fixed column, so the dot count varies
  // with the label's length:
  //
  //   master.pike...: /usr/local/pike/8.0.1116/lib/master.pike     <- 3 dots
  //   Module path...: /usr/local/pike/8.0.1116/lib/modules         <- 3 dots
  //   Include path..: /usr/local/pike/8.0.1116/lib/include         <- 2 dots
  //   Program path..:                                              <- 2 dots
  //
  // These patterns matched a literal `...`, so the two 12-character labels
  // never matched: includePath stayed empty, and every system include
  // (`#include <stdio.h>`) failed to resolve. Match one-or-more dots.
  for (const line of output.split("\n")) {
    const masterMatch = line.match(/^master\.pike\.+\s*:\s*(.+)$/);
    if (masterMatch) {
      const masterPath = masterMatch[1].trim();
      pikeHome = masterPath.endsWith("/lib/master.pike")
        ? join(masterPath, "..", "..")
        : join(masterPath, "..");
    }

    const moduleMatch = line.match(/^Module path\.+\s*:\s*(.+)$/);
    if (moduleMatch) {
      systemModulePath = moduleMatch[1].trim();
      if (!pikeHome) {
        pikeHome = systemModulePath.endsWith("/lib/modules")
          ? join(systemModulePath, "..", "..")
          : join(systemModulePath, "..");
      }
    }

    const includeMatch = line.match(/^Include path\.+\s*:\s*(.+)$/);
    if (includeMatch) includePath = includeMatch[1].trim();

    const programMatch = line.match(/^Program path\.+\s*:\s*(.+)$/);
    if (programMatch) programPath = programMatch[1].trim();
  }

  return { pikeHome, systemModulePath, includePath, programPath };
}

/**
 * Phase 2: Detect Pike version from `pike --version` and probe
 * version-specific directories.
 */
async function detectPikeHomeFromVersion(pike: string): Promise<string> {
  let detectedVersion = "";
  try {
    const versionOutput = await execFileAsync(pike, ["--version"], { timeout: 5000 });
    const versionMatch = versionOutput.match(/Pike v(\d+\.\d+) release (\d+)/);
    if (versionMatch) detectedVersion = `${versionMatch[1]}.${versionMatch[2]}`;
  } catch { /* Pike not available */ }

  if (!detectedVersion) return "";
  const candidates = [
    `/usr/local/pike/${detectedVersion}`,
    `/opt/pike/${detectedVersion}`,
    `/usr/lib/pike/${detectedVersion}`,
    `/opt/homebrew/opt/pike/${detectedVersion}`,
    `/usr/local/Cellar/pike/${detectedVersion}`,
  ];
  for (const c of candidates) {
    if (await pathExists(c)) return c;
  }
  return "";
}

/**
 * Phase 3: Scan well-known directories for any Pike version (newest first).
 */
async function scanForPikeHome(): Promise<string> {
  const scanDirs = [
    "/usr/local/pike", "/opt/pike", "/usr/lib/pike",
    "/opt/homebrew/opt/pike", "/usr/local/Cellar/pike",
  ];
  for (const scanDir of scanDirs) {
    if (!(await isDir(scanDir))) continue;
    try {
      const entries = (await readdir(scanDir, { withFileTypes: true }))
        .filter(d => d.isDirectory())
        .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
      if (entries.length > 0) return join(scanDir, entries[0].name);
    } catch { /* Permission denied — skip */ }
  }
  return "";
}

/**
 * Build the final PikePaths from detected values, ensuring workspace root
 * is always first in each path list.
 */
function buildPikePaths(
  workspaceRoot: string,
  pikeHome: string,
  systemModulePath: string,
  includePath: string,
  programPath: string,
): PikePaths {
  const modulePaths = [workspaceRoot];
  if (systemModulePath || pikeHome) {
    modulePaths.push(systemModulePath || join(pikeHome, "lib", "modules"));
  }

  // Fall back to pikeHome/lib/include, mirroring modulePaths above: pikeHome
  // can be found by version probe or directory scan even when --show-paths
  // yields nothing, and without a system include path `#include <stdio.h>`
  // cannot resolve at all.
  const includePaths = [workspaceRoot];
  if (includePath || pikeHome) {
    includePaths.push(includePath || join(pikeHome, "lib", "include"));
  }

  const programPaths = [workspaceRoot];
  if (programPath) programPaths.push(programPath);

  // Derive LD_LIBRARY_PATH from pikeHome if auto-detected.
  // Pike's native modules (Nettle, etc.) are installed under pikeHome/lib.
  const ldLibraryPath = pikeHome
    ? join(pikeHome, "lib")
    : "";

  return { pikeHome, modulePaths, includePaths, programPaths, ldLibraryPath };
}

// ---------------------------------------------------------------------------
// Main detection entry point
// ---------------------------------------------------------------------------

/** De-duplicate a path list, preserving first-seen order. */
function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Detect Pike installation paths.
 *
 * Accepts optional user-supplied overrides from VSCode settings.
 * When ALL paths are overridden, auto-detection is skipped entirely
 * (no Pike subprocess spawned, no filesystem scanning).
 *
 * When only some paths are overridden, auto-detection fills in the gaps
 * and the overrides take precedence over detected values.
 */
export async function detectPikePaths(
  workspaceRoot: string,
  pikeBinaryPath?: string,
  overrides?: PikePathOverrides,
): Promise<PikePaths> {
  const pike = pikeBinaryPath ?? "pike";

  // If the user has provided all path overrides, use them directly —
  // no subprocess spawning, no filesystem scanning.
  if (overrides?.pikeHome && overrides?.modulePaths && overrides?.includePaths && overrides?.programPaths) {
    return {
      pikeHome: overrides.pikeHome,
      modulePaths: [workspaceRoot, ...overrides.modulePaths],
      includePaths: [workspaceRoot, ...overrides.includePaths],
      programPaths: [workspaceRoot, ...overrides.programPaths],
      ldLibraryPath: "",
    };
  }

  // Auto-detect from system (spawns Pike subprocess).
  const paths = await queryShowPaths(pike);
  let pikeHome = paths.pikeHome;
  let systemModulePath = paths.systemModulePath;
  const includePath = paths.includePath;
  const programPath = paths.programPath;

  // Phase 2: version-based fallback
  if (!pikeHome) pikeHome = await detectPikeHomeFromVersion(pike);

  // Phase 3: scan well-known directories
  if (!pikeHome) pikeHome = await scanForPikeHome();

  const result = buildPikePaths(workspaceRoot, pikeHome, systemModulePath, includePath, programPath);

  // Apply individual overrides — user settings take precedence over detected
  // values, but do NOT discard them: the config UI documents these as
  // "prepended to auto-detected paths". Merging keeps system paths (e.g. Pike's
  // own include dir for `<stdio.h>`) resolvable while the user's custom dirs win
  // by ordering. Without this merge, adding one custom include path silently
  // breaks resolution of every system header.
  if (overrides?.pikeHome) result.pikeHome = overrides.pikeHome;
  if (overrides?.modulePaths && overrides.modulePaths.length > 0) {
    result.modulePaths = dedupePaths([workspaceRoot, ...overrides.modulePaths, ...result.modulePaths]);
  }
  if (overrides?.includePaths && overrides.includePaths.length > 0) {
    result.includePaths = dedupePaths([workspaceRoot, ...overrides.includePaths, ...result.includePaths]);
  }
  if (overrides?.programPaths && overrides.programPaths.length > 0) {
    result.programPaths = dedupePaths([workspaceRoot, ...overrides.programPaths, ...result.programPaths]);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Lazy singleton: cached Pike paths promise (in-memory, parameter-keyed)
// ---------------------------------------------------------------------------

let pikePathsKey = "";
let pikePathsPromise: Promise<PikePaths> | null = null;

/**
 * Get Pike installation paths (lazy, cached in memory).
 * Safe to call repeatedly; the detection runs once per unique set of parameters.
 * If parameters change (e.g. user updates Pike binary path in settings),
 * the cache is invalidated and detection re-runs.
 */
export function getPikePaths(workspaceRoot: string, pikeBinaryPath?: string, overrides?: PikePathOverrides): Promise<PikePaths> {
  const key = `${workspaceRoot}\0${pikeBinaryPath ?? ""}\0${JSON.stringify(overrides ?? null)}`;
  if (key !== pikePathsKey || !pikePathsPromise) {
    pikePathsKey = key;
    pikePathsPromise = detectPikePaths(workspaceRoot, pikeBinaryPath, overrides);
  }
  return pikePathsPromise;
}
