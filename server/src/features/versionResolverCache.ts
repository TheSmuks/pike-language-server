/**
 * Cache of version-scoped ModuleResolvers for WorkspaceIndex.
 *
 * Files with a #pike directive resolve modules against that Pike version's
 * module paths. We cache one ModuleResolver per version to avoid rebuilding
 * the resolver (and its resolution caches) per call. Pike versions are finite
 * in practice, so the cache is capped with FIFO eviction as a fail-safe.
 *
 * Extracted from workspaceIndexClass.ts to keep that file focused on index
 * state. The class holds a single instance and delegates to it.
 */

import { ModuleResolver } from "./moduleResolver";
import type { PikePaths } from "./moduleResolver";
import { pathToUri } from "../util/uri";
import type { FileEntry } from "./workspaceTypes";

/** Pike version directives are finite in practice; cap the cache to fail-safe. */
const VERSION_RESOLVER_MAX = 16;

export class ScopedResolverCache {
  private readonly cache = new Map<string, ModuleResolver>();
  private readonly baseResolver: ModuleResolver;
  private readonly workspaceRoot: string;
  private readonly pikePaths: PikePaths;

  constructor(baseResolver: ModuleResolver, workspaceRoot: string, pikePaths: PikePaths) {
    this.baseResolver = baseResolver;
    this.workspaceRoot = workspaceRoot;
    this.pikePaths = pikePaths;
  }

  /**
   * Return a resolver scoped to the entry's #pike version, or the base
   * resolver when the entry has no version directive (or matches the base).
   */
  get(entry: FileEntry | undefined): ModuleResolver {
    // No directive, or identical to the base resolver's version — use the base.
    if (!entry?.pikeVersion) return this.baseResolver;
    if (entry.pikeVersion === this.baseResolver["pikeVersion"]) return this.baseResolver;

    const versionKey = `${entry.pikeVersion.major}.${entry.pikeVersion.minor}`;
    const cached = this.cache.get(versionKey);
    if (cached) return cached;

    this.evictIfNeeded();
    const scoped = new ModuleResolver({
      workspaceRoot: pathToUri(this.workspaceRoot),
      pikePaths: this.pikePaths,
      pikeVersion: entry.pikeVersion,
    });
    this.cache.set(versionKey, scoped);
    return scoped;
  }

  /** FIFO eviction so a pathological number of versions cannot grow unbounded. */
  private evictIfNeeded(): void {
    if (this.cache.size < VERSION_RESOLVER_MAX) return;
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey) this.cache.delete(oldestKey);
  }

  clear(): void {
    this.cache.clear();
  }
}
