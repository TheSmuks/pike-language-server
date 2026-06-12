/**
 * Pike worker path resolution — extracted from PikeWorkerProcess to keep
 * each file under 500 lines.
 *
 * Resolves harness directory and worker script paths for both dev layout
 * (repo root) and VSIX layout (extension root).
 */

import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";

const _thisDir = typeof __dirname !== 'undefined'
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

/**
 * Resolve a directory by trying multiple candidate paths.
 * Returns the first path that exists and is a directory, or undefined.
 *
 * Supports both dev layout and VSIX layout:
 * - Dev:       server/dist/ → 3 levels up → repo root
 * - VSIX:      server/dist/ → 2 levels up → extension root
 */
export function resolveDir(...candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Permission or access errors — treat as non-existent.
    }
  }
  return undefined;
}

/**
 * Resolve a file by trying multiple candidate paths.
 * Returns the first path that exists and is a file, or undefined.
 */
export function resolveFile(...candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Permission or access errors — treat as non-existent.
    }
  }
  return undefined;
}

// Dev layout: _thisDir = server/dist/; 3x ".." = repo root
export const DEV_ROOT = resolve(_thisDir, "..", "..", "..");
// VSIX layout: _thisDir = server/dist/; 2x ".." = extension root
export const VSIX_ROOT = resolve(_thisDir, "..", "..");

export const HARNESS_DIR = resolveDir(
  join(DEV_ROOT, "harness"),
  join(VSIX_ROOT, "harness"),
);
export const WORKER_SCRIPT = resolveFile(
  join(DEV_ROOT, "harness", "worker.pike"),
  join(VSIX_ROOT, "harness", "worker.pike"),
);
export const INTROSPECT_PATH = resolveDir(
  join(DEV_ROOT, "modules", "Introspect", "src"),
);

// ---------------------------------------------------------------------------
// Spawn-command construction
// ---------------------------------------------------------------------------

export interface SpawnCommand {
  cmd: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Build the Pike worker spawn command, argument list, cwd, and environment.
 *
 * On Linux, wraps the binary in `nice` for CPU politeness under contention.
 * Merges libraryPath into LD_LIBRARY_PATH so Pike's native modules can find
 * shared libraries not on the default linker search path.
 */
export function buildSpawnCommand(
  pikeBinaryPath: string,
  niceValue: number,
  libraryPath: string | undefined,
): SpawnCommand {
  const baseArgs = ["-M", HARNESS_DIR!];
  if (INTROSPECT_PATH) baseArgs.push("-M", INTROSPECT_PATH);
  baseArgs.push(WORKER_SCRIPT!);

  let cmd: string;
  let args: string[];

  if (niceValue > 0 && process.platform === "linux") {
    cmd = "nice";
    args = ["-n" + niceValue, pikeBinaryPath, ...baseArgs];
  } else {
    cmd = pikeBinaryPath;
    args = baseArgs;
  }

  const env = { ...process.env } as NodeJS.ProcessEnv;
  if (libraryPath) {
    const base = process.env.LD_LIBRARY_PATH ?? "";
    env.LD_LIBRARY_PATH = base ? `${libraryPath}:${base}` : libraryPath;
  }

  return { cmd, args, cwd: VSIX_ROOT || DEV_ROOT, env };
}

/**
 * Throw a descriptive error if the harness directory or worker script
 * cannot be resolved in either dev or VSIX layout.
 */
export function assertHarnessReady(): void {
  if (!HARNESS_DIR) throw new Error(
    `Pike worker: harness directory not found.\n` +
    `  Dev layout: ${join(DEV_ROOT, "harness")}\n` +
    `  VSIX layout: ${join(VSIX_ROOT, "harness")}`,
  );
  if (!WORKER_SCRIPT) throw new Error(
    `Pike worker: worker.pike not found.\n` +
    `  Dev layout: ${join(DEV_ROOT, "harness", "worker.pike")}\n` +
    `  VSIX layout: ${join(VSIX_ROOT, "harness", "worker.pike")}`,
  );
}
