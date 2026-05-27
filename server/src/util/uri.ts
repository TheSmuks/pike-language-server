/**
 * URI utilities — standardized file URI <-> path conversion.
 *
 * All server code MUST use these functions instead of manual `.slice(7)`
 * or `.replace("file://", "")`. Node's `fileURLToPath` handles
 * percent-encoding, Windows drive letters, and host authorities correctly.
 *
 * Canonicalization: `normalizeUri` resolves symlinks via `fs.realpathSync`
 * and rebuilds the URI via `pathToFileURL`. This ensures that files
 * reached through different paths (e.g., a symlink vs the real path)
 * always map to the same index key in WorkspaceIndex.
 */

import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

/**
 * Convert a file:// URI to a filesystem path.
 * Handles percent-encoding, Windows drive letters, and host authorities.
 * If the URI is not a file:// URI, returns it unchanged.
 */
export function uriToPath(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  return fileURLToPath(uri);
}

/**
 * Convert a filesystem path to a file:// URI.
 */
export function pathToUri(path: string): string {
  return pathToFileURL(path).href;
}

/**
 * Canonicalize a file:// URI by resolving symlinks via realpath.
 *
 * This is the critical normalization that ensures the WorkspaceIndex
 * always uses the same key for a given file, regardless of how it was
 * reached. Without this, a file opened via VSCode (which may resolve
 * symlinks) and the same file resolved by ModuleResolver (which uses
 * the path as reported by Pike) could produce different URIs.
 *
 * For non-file:// URIs, returns the URI unchanged.
 * If realpath fails (file deleted, permissions), returns the original URI
 * so the caller can still use it for removal/cleanup.
 */
export function normalizeUri(uri: string): string {
  if (!uri.startsWith("file://")) return uri;
  try {
    const filePath = fileURLToPath(uri);
    const realPath = realpathSync(filePath);
    return pathToFileURL(realPath).href;
  } catch {
    // File may not exist yet (e.g., created event before file is written).
    // Fall back to path normalization only.
    try {
      const filePath = fileURLToPath(uri);
      return pathToFileURL(filePath).href;
    } catch {
      return uri;
    }
  }
}
