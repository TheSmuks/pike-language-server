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