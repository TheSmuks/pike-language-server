/**
 * Generic size-bounded LRU cache.
 *
 * Evicts least-recently-used entries when either the entry count or byte
 * ceiling is exceeded.  Byte size is provided per-entry via `estimateSize`;
 * an optional `onEvict` callback handles resource cleanup (e.g., tree-sitter
 * `tree.delete()`).
 *
 * Used by:
 * - `parser.ts` — tree-sitter parse tree cache (cleanup: tree.delete)
 * - `server.ts` — Pike worker response cache + autodoc XML cache
 */

export interface LRUOptions<T> {
  /** Maximum number of entries. */
  maxEntries: number;
  /** Maximum total bytes across all entries. */
  maxBytes: number;
  /** Estimate the byte size of a cached value. */
  estimateSize: (value: T) => number;
  /** Called when an entry is evicted. Use for cleanup (e.g., tree.delete()). */
  onEvict?: (key: string, value: T) => void;
}

export class LRUCache<T> {
  // Recency is encoded by Map insertion order: the first key is the
  // least-recently-used, the last is the most-recently-used. get() and set()
  // move the touched key to the tail by delete+re-insert, so eviction is O(1)
  // (take the first key) instead of an O(n) scan for the oldest entry.
  private readonly map = new Map<string, { value: T; bytes: number }>();
  private totalBytes = 0;
  private readonly opts: LRUOptions<T>;

  constructor(opts: LRUOptions<T>) {
    this.opts = opts;
  }

  /** Current number of entries. */
  get size(): number {
    return this.map.size;
  }

  /** Current total bytes. */
  get bytes(): number {
    return this.totalBytes;
  }

  /** Get an entry, updating LRU order. Returns undefined if not found. */
  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Move to the tail (most-recently-used) so it evicts last.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  /** Check whether a key exists (without updating LRU order). */
  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Store an entry, evicting if necessary. */
  set(key: string, value: T): void {
    // Remove old entry if present
    const old = this.map.get(key);
    if (old) {
      this.totalBytes -= old.bytes;
      this.opts.onEvict?.(key, old.value);
      this.map.delete(key);
    }

    const bytes = this.opts.estimateSize(value);

    // Evict until entry count ceiling is met
    while (this.map.size >= this.opts.maxEntries && this.map.size > 0) {
      this.evictOne();
    }

    // Evict until byte ceiling is met
    while (this.totalBytes + bytes > this.opts.maxBytes && this.map.size > 0) {
      this.evictOne();
    }

    this.map.set(key, { value, bytes });
    this.totalBytes += bytes;
  }

  /** Delete a specific entry, running onEvict if present. */
  delete(key: string): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.totalBytes -= entry.bytes;
    this.opts.onEvict?.(key, entry.value);
    this.map.delete(key);
    return true;
  }

  /** Remove all entries, running onEvict for each. */
  clear(): void {
    if (this.opts.onEvict) {
      for (const [key, entry] of this.map) {
        this.opts.onEvict(key, entry.value);
      }
    }
    this.map.clear();
    this.totalBytes = 0;
  }

  /** Iterate entries in LRU order — least-recently-used first. */
  entries(): IterableIterator<[string, T]> {
    const inner = this.map.entries();
    return (function* () {
      for (const [key, entry] of inner) {
        yield [key, entry.value] as [string, T];
      }
    })();
  }

  /** Evict the least-recently-used entry: the first key in insertion order. */
  private evictOne(): void {
    const oldestKey = this.map.keys().next().value;
    if (oldestKey !== undefined) {
      this.delete(oldestKey);
    }
  }
}
