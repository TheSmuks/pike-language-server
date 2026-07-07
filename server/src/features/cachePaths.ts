/**
 * Cache-directory resolution and legacy migration.
 *
 * The persistent cache lives under the OS user cache dir (not inside the
 * workspace), keyed by a hash of the workspace path so caches never collide and
 * never pollute the project tree. Older versions wrote an in-workspace
 * `.pike-lsp/` dir; that is migrated to the global location on first load.
 *
 * Extracted from persistentCache so that file stays under the module-size gate.
 */

import { mkdir, rm, rename, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

/** Legacy per-workspace cache dir. Migrated to the global cache on first load. */
const LEGACY_CACHE_DIR = ".pike-lsp";
/** Namespace under the OS user cache dir where all workspace caches live. */
const GLOBAL_CACHE_NAMESPACE = "pike-lsp";

/**
 * OS user cache base directory (respects XDG_CACHE_HOME / LOCALAPPDATA).
 */
function userCacheBase(): string {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
  }
  return process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
}

/**
 * Get the cache root path for a workspace.
 *
 * e.g. ~/.cache/pike-lsp/myproject-a1b2c3d4e5f6g7h8/
 * The human-readable basename prefix aids debugging; the hash guarantees
 * uniqueness across workspaces that share a basename.
 */
export function getCachePath(workspaceRoot: string): string {
  const hash = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  const label = (basename(workspaceRoot).replace(/[^a-zA-Z0-9._-]/g, "_")) || "workspace";
  return join(userCacheBase(), GLOBAL_CACHE_NAMESPACE, `${label}-${hash}`);
}

/**
 * Migrate a legacy in-workspace `.pike-lsp/` cache to the global cache dir.
 *
 * Runs once: after the move the legacy dir no longer exists, so subsequent
 * startups short-circuit on the existsSync check. Best-effort — a failed
 * migration falls back to a fresh cache rather than blocking startup.
 */
export async function migrateLegacyCache(workspaceRoot: string, cacheRoot: string): Promise<void> {
  const legacyDir = join(workspaceRoot, LEGACY_CACHE_DIR);
  if (!existsSync(legacyDir)) return;

  // Global cache already populated — the legacy dir is stale; just remove it.
  if (existsSync(cacheRoot)) {
    await rm(legacyDir, { recursive: true, force: true }).catch(() => {});
    return;
  }

  try {
    await mkdir(dirname(cacheRoot), { recursive: true });
    await rename(legacyDir, cacheRoot);
  } catch {
    // rename fails across devices — copy then remove.
    try {
      await cp(legacyDir, cacheRoot, { recursive: true });
      await rm(legacyDir, { recursive: true, force: true });
    } catch {
      // Give up: startup proceeds with a fresh cache.
    }
  }
}
