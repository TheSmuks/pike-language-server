/**
 * URI utilities — standardized file URI ↔ path conversion.
 *
 * All server code MUST use these functions instead of manual `.slice(7)`
 * or `.replace("file://", "")`. Node's `fileURLToPath` handles
 * percent-encoding, Windows drive letters, and host authorities correctly.
 */

import { fileURLToPath, pathToFileURL } from "node:url";

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
