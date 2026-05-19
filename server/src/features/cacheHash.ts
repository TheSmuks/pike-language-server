/**
 * DJB2 content hash for cache validity.
 *
 * Extracted from WorkspaceIndex so it can be used by the cache refresh
 * logic without coupling to the full index class.
 */

export function hashContent(content: string): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}
