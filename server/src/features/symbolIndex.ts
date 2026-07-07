/**
 * Resident workspace symbol index (modern-LSP tier-1).
 *
 * An always-resident, compact index of outline symbols (name + kind + location)
 * built once from the cache manifest at startup. It lets workspace/symbol answer
 * from lightweight metadata for every previously-cached file — without hydrating
 * full symbol tables or scanning source — which is how clangd (Dex/MemIndex) and
 * gopls (workspace symbol index) keep global search cheap under lazy loading.
 *
 * Storage is columnar to avoid per-symbol object overhead (the dominant cost of
 * a naive object-per-symbol index): URIs and kinds are deduped, and name ranges
 * are packed into a flat number array (name ranges are single-line). Full
 * SymbolRef objects are materialized only for the handful of search hits.
 *
 * It is a snapshot: files edited/opened this session are authoritative via their
 * live symbol tables (the caller unions those and skips the snapshot for them).
 */

import type { CacheManifestEntry } from "./cacheManifest";

export interface SymbolRef {
  uri: string;
  name: string;
  kind: string;
  nameRange: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export class SymbolIndex {
  private readonly uris: string[] = [];       // deduped file URIs
  private readonly names: string[] = [];      // one per symbol
  private readonly lowerNames: string[] = []; // precomputed for prefix search
  private readonly kinds: string[] = [];      // interned DeclKind strings
  private readonly uriId: number[] = [];      // symbol → index into `uris`
  private readonly ranges: number[] = [];     // 3 per symbol: line, startChar, endChar

  constructor(manifest: CacheManifestEntry[]) {
    const uriIndex = new Map<string, number>();
    const kindIntern = new Map<string, string>();

    for (const entry of manifest) {
      if (!entry.symbols || entry.symbols.length === 0) continue;

      let uid = uriIndex.get(entry.uri);
      if (uid === undefined) {
        uid = this.uris.length;
        this.uris.push(entry.uri);
        uriIndex.set(entry.uri, uid);
      }

      for (const s of entry.symbols) {
        this.uriId.push(uid);
        this.names.push(s.name);
        this.lowerNames.push(s.name.toLowerCase());
        let kind = kindIntern.get(s.kind);
        if (kind === undefined) { kind = s.kind; kindIntern.set(kind, kind); }
        this.kinds.push(kind);
        this.ranges.push(s.nameRange.start.line, s.nameRange.start.character, s.nameRange.end.character);
      }
    }
  }

  /** Case-insensitive prefix search. `lowerQuery` must already be lowercased. */
  search(lowerQuery: string): SymbolRef[] {
    const out: SymbolRef[] = [];
    for (let i = 0; i < this.names.length; i++) {
      if (lowerQuery !== "" && !this.lowerNames[i].startsWith(lowerQuery)) continue;
      const b = i * 3;
      out.push({
        uri: this.uris[this.uriId[i]],
        name: this.names[i],
        kind: this.kinds[i],
        nameRange: {
          start: { line: this.ranges[b], character: this.ranges[b + 1] },
          end: { line: this.ranges[b], character: this.ranges[b + 2] },
        },
      });
    }
    return out;
  }

  get size(): number {
    return this.names.length;
  }
}
