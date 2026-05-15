/**
 * Pike binary detection — path discovery from system.
 *
 * Extracted from moduleResolver.ts to keep it under 500 lines.
 * Re-exported by moduleResolver.ts so existing imports continue to work.
 */

import { join, dirname } from "node:path";
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
// detectPikePaths
// ---------------------------------------------------------------------------

/**
 * Detect Pike installation paths from the running Pike binary.
 * Falls back to well-known paths.
 */
export async function detectPikePaths(workspaceRoot: string, pikeBinaryPath?: string): Promise<PikePaths> {
  const pike = pikeBinaryPath ?? "pike";
  let pikeHome = "";
  let systemModulePath = "";
  let includePath = "";
  let programPath = "";

  // Try to get actual paths from the Pike binary
  try {
    const output = await execFileAsync(pike, ["--show-paths"], { timeout: 5000 });

    for (const line of output.split("\n")) {
      const masterMatch = line.match(/^master\.pike\.\.\.\s*:\s*(.+)$/);
      if (masterMatch) {
        const masterPath = masterMatch[1].trim();
        // Source build layout: $PIKE_HOME/lib/master.pike
        // Package layout:      $PIKE_HOME/master.pike
        if (masterPath.endsWith("/lib/master.pike")) {
          pikeHome = dirname(dirname(masterPath));
        } else {
          pikeHome = dirname(masterPath);
        }
      }

      const moduleMatch = line.match(/^Module path\.\.\.\s*:\s*(.+)$/);
      if (moduleMatch) {
        systemModulePath = moduleMatch[1].trim();
        if (!pikeHome) {
          // Source build: $PIKE_HOME/lib/modules
          // Package layout: $PIKE_HOME/modules
          if (systemModulePath.endsWith("/lib/modules")) {
            pikeHome = dirname(dirname(systemModulePath));
          } else {
            pikeHome = dirname(systemModulePath);
          }
        }
      }

      const includeMatch = line.match(/^Include path\.\.\s*:\s*(.+)$/);
      if (includeMatch) {
        includePath = includeMatch[1].trim();
      }

      const programMatch = line.match(/^Program path\.\.\s*:\s*(.+)$/);
      if (programMatch) {
        programPath = programMatch[1].trim();
      }
    }
  } catch {
    // Pike binary not found or failed — fall through to heuristic detection
  }

  // Fallback: detect version from `pike --version` and check common locations
  if (!pikeHome) {
    let detectedVersion = "";
    try {
      const versionOutput = await execFileAsync(pike, ["--version"], { timeout: 5000 });
      const versionMatch = versionOutput.match(/Pike v(\d+\.\d+) release (\d+)/);
      if (versionMatch) {
        detectedVersion = `${versionMatch[1]}.${versionMatch[2]}`;
      }
    } catch {
      // Pike not available
    }

    if (detectedVersion) {
      const versionCandidates = [
        `/usr/local/pike/${detectedVersion}`,
        `/opt/pike/${detectedVersion}`,
        `/usr/lib/pike/${detectedVersion}`,
        `/opt/homebrew/opt/pike/${detectedVersion}`,
        `/usr/local/Cellar/pike/${detectedVersion}`,
      ];
      for (const candidate of versionCandidates) {
        if (await pathExists(candidate)) {
          pikeHome = candidate;
          break;
        }
      }
    }
  }

  // Final fallback: scan for any Pike version in well-known directories
  if (!pikeHome) {
    const scanDirs = ["/usr/local/pike", "/opt/pike", "/usr/lib/pike", "/opt/homebrew/opt/pike", "/usr/local/Cellar/pike"];
    for (const scanDir of scanDirs) {
      if (!(await isDir(scanDir))) continue;
      try {
        const entries = (await readdir(scanDir, { withFileTypes: true }))
          .filter(d => d.isDirectory())
          .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
        if (entries.length > 0) {
          pikeHome = join(scanDir, entries[0].name);
          break;
        }
      } catch {
        // Permission denied or similar — skip
      }
    }
  }

  if (!systemModulePath && pikeHome) {
    systemModulePath = join(pikeHome, "lib", "modules");
  }

  const modulePaths: string[] = [workspaceRoot];
  if (systemModulePath) {
    modulePaths.push(systemModulePath);
  }

  const includePaths: string[] = [workspaceRoot];
  if (includePath) {
    includePaths.push(includePath);
  }

  const programPaths: string[] = [workspaceRoot];
  if (programPath) {
    programPaths.push(programPath);
  }

  return {
    pikeHome,
    modulePaths,
    includePaths,
    programPaths,
  };
}

// ---------------------------------------------------------------------------
// Lazy singleton: cached Pike paths promise
// ---------------------------------------------------------------------------

let pikePathsPromise: Promise<PikePaths> | null = null;

/**
 * Get Pike installation paths (lazy, cached).
 * Safe to call repeatedly; the detection runs only once.
 */
export function getPikePaths(workspaceRoot: string, pikeBinaryPath?: string): Promise<PikePaths> {
  if (!pikePathsPromise) {
    pikePathsPromise = detectPikePaths(workspaceRoot, pikeBinaryPath);
  }
  return pikePathsPromise;
}
