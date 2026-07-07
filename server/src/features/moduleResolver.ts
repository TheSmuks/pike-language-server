/**
 * ModuleResolver: resolves Pike module paths to file URIs.
 *
 * Implements a simplified version of Pike's master.pike resolution algorithm
 * (decision 0010). Supports:
 * - Module resolution: "Stdio.File" → URI
 * - Inherit resolution: "file.pike", Foo.Bar, .Foo → URI
 * - Import resolution: "Stdio" → URI (module root)
 * - #pike version-aware paths
 *
 * Resolution order matches Pike:
 * 1. Relative to current file (for inherit string paths)
 * 2. Workspace module/program paths
 * 3. System Pike module paths
 *
 * Priority per Pike's prio_from_filename: .pmod (3) > .pike (1)
 * (.so skipped — not parseable by tree-sitter)
 */

import { join, dirname, resolve, sep } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  pathExists,
  isDir,
  isFile,
  findWithExtension,
  resolveIncludeUncached,
  resolveRelativeInheritTarget,
  resolveDirectoryModulePmod,
  type IncludeDeps,
} from "./moduleResolverInternal";

// Re-export pike detection utilities for backward compatibility
export { detectPikePaths, getPikePaths } from "./pikeDetection";
export type { PikePaths, PikePathOverrides } from "./pikeDetection";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolveResult {
  /** The resolved file URI. */
  uri: string;
  /** How the resolution was performed (for debugging/testing). */
  source: "relative" | "workspace_module" | "workspace_program" | "system_module" | "not_found";
}

export interface ModuleResolverOptions {
  /** Workspace root URI. */
  workspaceRoot: string;
  /** Pike installation paths. */
  pikePaths: import("./pikeDetection").PikePaths;
  /** #pike version directive for the current file, if present. */
  pikeVersion: { major: number; minor: number } | null;
}

// ---------------------------------------------------------------------------
// ModuleResolver
// ---------------------------------------------------------------------------

export class ModuleResolver {
  private readonly workspaceRoot: string;
  private readonly pikePaths: import("./pikeDetection").PikePaths;
  private readonly pikeVersion: { major: number; minor: number } | null;
  /** Cache: module path → resolved URI. Bounded to prevent unbounded growth on large workspaces. */
  private readonly cache = new Map<string, ResolveResult | null>();
  private static readonly CACHE_MAX_ENTRIES = 2000;

  constructor(options: ModuleResolverOptions) {
    this.workspaceRoot = fileURLToPath(options.workspaceRoot);
    this.pikePaths = options.pikePaths;
    this.pikeVersion = options.pikeVersion;
  }

  /** Pike include paths (-I), from `pike --show-paths`. */
  get includePaths(): string[] { return this.pikePaths.includePaths; }

  /** Clear the resolution cache. */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Security boundary check: reject paths outside the workspace and Pike system paths.
   * Prevents path traversal via `inherit "/etc/passwd"` or `inherit "../../../etc/shadow"`.
   * Returns the normalized path if allowed, null if outside boundaries.
   *
   * `baseDir` is the importing file's own directory. A file's siblings and
   * sub-directories are always a legitimate resolution root — Pike resolves
   * relative `inherit`/`import` against the file itself — so they are allowed
   * even when the file lives outside the workspace root. Without this, opening a
   * single file outside the workspace leaves every cross-file `inherit` (and the
   * symbols it brings in) unresolved, degrading the file to "dumb mode". The
   * guard still blocks upward traversal, since `../../etc` does not stay under
   * `baseDir`.
   */
  private normalizeAndCheck(resolvedPath: string, baseDir?: string): string | null {
    const normalized = resolve(resolvedPath);
    if (baseDir && normalized.startsWith(baseDir)) return normalized;
    if (normalized.startsWith(this.workspaceRoot)) return normalized;
    if (this.pikePaths.pikeHome && normalized.startsWith(this.pikePaths.pikeHome)) return normalized;
    // Also allow any declared module/include/program paths
    for (const allowed of this.pikePaths.modulePaths) {
      if (normalized.startsWith(allowed)) return normalized;
    }
    for (const allowed of this.pikePaths.includePaths) {
      if (normalized.startsWith(allowed)) return normalized;
    }
    for (const allowed of this.pikePaths.programPaths) {
      if (normalized.startsWith(allowed)) return normalized;
    }
    return null;
  }

  /**
   * Synchronous cache-only lookup for a module path.
   * Returns the cached ResolveResult or undefined if not cached.
   * Used by WorkspaceIndex to provide a sync interface to symbolTable.ts.
   */
  getCachedModule(modulePath: string, currentFile: string): ResolveResult | null | undefined {
    return this.cache.get(`mod:${modulePath}:${currentFile}`);
  }

  /**
   * Synchronous cache-only lookup for an inherit path.
   * Returns the cached ResolveResult or undefined if not cached.
   */
  getCachedInherit(pathText: string, isStringLiteral: boolean, currentFile: string): ResolveResult | null | undefined {
    return this.cache.get(`inh:${pathText}:${isStringLiteral}:${currentFile}`);
  }

  /**
   * Synchronous cache-only lookup for an #include path.
   * Returns the cached ResolveResult or undefined if not cached.
   */
  getCachedInclude(pathText: string, isSystem: boolean, currentFile: string): ResolveResult | null | undefined {
    return this.cache.get(`inc:${pathText}:${isSystem}:${currentFile}`);
  }

  /**
   * Resolve a module path like "Stdio.File" or "cross_import_a".
   * Returns null if unresolvable.
   */
  async resolveModule(modulePath: string, currentFile: string): Promise<ResolveResult | null> {
    const cacheKey = `mod:${modulePath}:${currentFile}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const result = await this.doResolveModule(modulePath, currentFile);
    this.cache.set(cacheKey, result);
    this.evictIfNeeded();
    return result;
  }

  /**
   * Resolve an inherit path.
   * - String literal: `inherit "file.pike"` → resolve as file path
   * - Identifier: `inherit Foo` → resolve as module
   * - Dot-path: `inherit Foo.Bar` → resolve module, find class
   * - Relative: `inherit .Foo` → resolve relative to current file dir
   */
  async resolveInherit(pathText: string, isStringLiteral: boolean, currentFile: string): Promise<ResolveResult | null> {
    const cacheKey = `inh:${pathText}:${isStringLiteral}:${currentFile}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    let result: ResolveResult | null;

    if (isStringLiteral) {
      // Strip quotes from string literal
      const rawPath = pathText.replace(/^"|"$/g, "");
      result = await this.resolveInheritString(rawPath, currentFile);
    } else if (pathText.startsWith(".")) {
      // Relative: .Foo → Foo.pike/Foo.pmod in same directory
      const relativeName = pathText.slice(1);
      result = await this.resolveRelativeModule(relativeName, currentFile);
    } else {
      // Identifier or dot-path: resolve as module
      result = await this.resolveModule(pathText, currentFile);
    }

    this.cache.set(cacheKey, result);
    this.evictIfNeeded();
    return result;
  }

  /**
   * Resolve an import path like "Stdio" or "Stdio.File".
   * Import brings all symbols from the module into scope.
   */
  async resolveImport(importPath: string, currentFile: string): Promise<ResolveResult | null> {
    // Import resolution is the same as module resolution
    return this.resolveModule(importPath, currentFile);
  }

  /**
   * Resolve a preprocessor `#include` target to a file URI.
   * - `#include <file.h>` (isSystem): search Pike's include directories (-I).
   * - `#include "file.h"`: resolve relative to the current file's directory,
   *   allowing upward (`../`) traversal — Pike splices the file in textually and
   *   resolves it relative to the includer, so a sibling/ancestor header is a
   *   legitimate target even outside the workspace root.
   *
   * `pathText` may be the raw path node text (with quotes or angle brackets) or
   * the already-stripped inner path; both are handled.
   */
  async resolveInclude(pathText: string, isSystem: boolean, currentFile: string): Promise<ResolveResult | null> {
    const cacheKey = `inc:${pathText}:${isSystem}:${currentFile}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const result = await resolveIncludeUncached(this.includeDeps(), pathText, isSystem, currentFile);
    this.cache.set(cacheKey, result);
    this.evictIfNeeded();
    return result;
  }

  /** Boundary/context the free include+relative resolvers need from this instance. */
  private includeDeps(): IncludeDeps {
    return {
      includePaths: this.includePaths,
      checkRoot: (p) => this.normalizeAndCheck(p),
    };
  }

  // ---------------------------------------------------------------------------
  // Internal: module resolution
  // ---------------------------------------------------------------------------

  private async doResolveModule(modulePath: string, currentFile: string): Promise<ResolveResult | null> {
    const segments = modulePath.split(".");
    if (segments.length === 0) return null;

    // Build the search paths for this file
    const searchPaths = await this.getSearchPaths(currentFile);

    // Resolve first segment as a module/file
    const firstName = segments[0];
    // Pike converts hyphens to underscores in module names
    const normalizedName = firstName.replace(/-/g, "_");

    let currentUri: string | null = null;
    let source: ResolveResult["source"] = "not_found";

    // Search paths in order
    for (const searchPath of searchPaths) {
      // Try original name first, then normalized (hyphens→underscores)
      let found = await this.findModuleInPath(firstName, searchPath);
      if (!found && normalizedName !== firstName) {
        found = await this.findModuleInPath(normalizedName, searchPath);
      }
      if (found) {
        currentUri = found;
        // Determine source based on search path type
        if (searchPath === dirname(currentFile) || searchPath === this.workspaceRoot) {
          source = "workspace_module";
        } else if (searchPath.startsWith(this.pikePaths.pikeHome)) {
          source = "system_module";
        } else {
          source = "workspace_module";
        }
        break;
      }
    }

    if (!currentUri) return null;

    // Resolve subsequent segments by indexing into the found module
    for (let i = 1; i < segments.length; i++) {
      const segment = segments[i];
      const segmentResult = await this.resolveSubModule(currentUri, segment);
      if (!segmentResult) return null;
      currentUri = segmentResult;
    }

    return { uri: currentUri, source };
  }

  // ---------------------------------------------------------------------------
  // Internal: inherit resolution
  // ---------------------------------------------------------------------------

  private async resolveInheritString(rawPath: string, currentFile: string): Promise<ResolveResult | null> {
    const currentDir = dirname(currentFile);

    if (rawPath.startsWith("/")) {
      // Absolute path — normalize and check boundary. No baseDir: an absolute
      // path is not resolved against the file, so it must stay within the
      // workspace/system boundaries.
      return this.tryInheritCandidate(this.normalizeAndCheck(rawPath));
    }
    if (rawPath.startsWith("./") || rawPath.startsWith("../")) {
      // Relative to current file — allow `../` traversal. Pike resolves an
      // inherit string relative to the includer, so an ancestor/sibling program
      // is a legitimate target even outside the workspace root. The boundary is
      // applied to the file actually found (after extension resolution).
      const resolved = resolve(currentDir, rawPath);
      return this.tryRelativeInheritCandidate(resolved);
    }
    // Pike's cast_to_program: search current dir first, then program paths
    return this.searchInheritProgramPaths(rawPath, currentDir);
  }

  /**
   * Resolve a relative inherit target (with optional extension append),
   * applying the relaxed boundary to whatever file is actually found. Permits
   * ancestor/sibling programs outside the workspace while refusing non-source
   * system files reached by upward traversal.
   */
  private tryRelativeInheritCandidate(resolvedBase: string): Promise<ResolveResult | null> {
    return resolveRelativeInheritTarget(this.includeDeps(), resolvedBase);
  }

  private async tryInheritCandidate(candidate: string | null): Promise<ResolveResult | null> {
    if (!candidate) return null;
    if (await pathExists(candidate)) {
      return { uri: pathToFileURL(candidate).href, source: "relative" };
    }
    const withExt = await findWithExtension(candidate);
    if (withExt) {
      return { uri: pathToFileURL(withExt).href, source: "relative" };
    }
    return null;
  }

  private async searchInheritProgramPaths(rawPath: string, currentDir: string): Promise<ResolveResult | null> {
    // Search current dir first. The importing file's own directory is a valid
    // resolution root even outside the workspace, so pass it as baseDir.
    const relativeToDir = resolve(currentDir, rawPath);
    const checkedRelative = this.normalizeAndCheck(relativeToDir, currentDir);
    if (checkedRelative) {
      if (await pathExists(checkedRelative)) {
        return { uri: pathToFileURL(checkedRelative).href, source: "relative" };
      }
      const withExtDir = await findWithExtension(checkedRelative);
      if (withExtDir) {
        return { uri: pathToFileURL(withExtDir).href, source: "relative" };
      }
    }

    // Then search program paths
    for (const progPath of this.pikePaths.programPaths) {
      const full = resolve(progPath, rawPath);
      const checked = this.normalizeAndCheck(full);
      if (!checked) continue;
      if (await pathExists(checked)) {
        return { uri: pathToFileURL(checked).href, source: "workspace_program" };
      }
    }
    // Try with extensions
    for (const progPath of this.pikePaths.programPaths) {
      const full = resolve(progPath, rawPath);
      const checked = this.normalizeAndCheck(full);
      if (!checked) continue;
      const found = await findWithExtension(checked);
      if (found) {
        return { uri: pathToFileURL(found).href, source: "workspace_program" };
      }
    }
    return null;
  }

  private async resolveRelativeModule(name: string, currentFile: string): Promise<ResolveResult | null> {
    const currentDir = dirname(currentFile);
    const found = await this.findModuleInPath(name, currentDir);
    return found ? { uri: found, source: "relative" } : null;
  }

  // ---------------------------------------------------------------------------
  // Internal: path searching
  // ---------------------------------------------------------------------------

  /**
   * Get the ordered list of module search paths for the current file.
   * Includes #pike version-specific paths if applicable.
   */
  private async getSearchPaths(currentFile: string): Promise<string[]> {
    const paths: string[] = [];

    // 1. Current file's directory (for relative resolution)
    paths.push(dirname(currentFile));

    // 2. Workspace + system module paths
    for (const mp of this.pikePaths.modulePaths) {
      if (!paths.includes(mp)) paths.push(mp);
    }

    // 3. #pike version-specific path (before default system path)
    if (this.pikeVersion) {
      const versionPath = join(
        this.pikePaths.pikeHome,
        "lib",
        `${this.pikeVersion.major}.${this.pikeVersion.minor}`,
        "modules",
      );
      if (await pathExists(versionPath) && !paths.includes(versionPath)) {
        paths.push(versionPath);
      }
    }

    return paths;
  }

  /**
   * Find a module named `name` within the given search path.
   * Tries directory module (.pmod/), then file module (.pmod), then .pike.
   * Priority: .pmod > .pike (same as Pike, minus .so).
   */
  private async findModuleInPath(name: string, searchPath: string): Promise<string | null> {
    // Validate the module name doesn't contain path separators or traversal.
    if (name.includes("/") || name.includes("\\") || name.includes("..")) return null;

    // 1. Directory module: name.pmod/module.pmod
    const dirPath = join(searchPath, `${name}.pmod`);
    if (await isDir(dirPath)) {
      // Return the module.pmod if it exists, otherwise the directory itself
      const moduleFile = join(dirPath, "module.pmod");
      if (await pathExists(moduleFile)) {
        return pathToFileURL(moduleFile).href;
      }
      // Directory module without module.pmod — still a valid module
      return pathToFileURL(dirPath + sep).href;
    }

    // 2. File module: name.pmod
    const fileModulePath = join(searchPath, `${name}.pmod`);
    if (await isFile(fileModulePath)) {
      return pathToFileURL(fileModulePath).href;
    }

    // 3. Pike file: name.pike
    const pikePath = join(searchPath, `${name}.pike`);
    if (await pathExists(pikePath)) {
      return pathToFileURL(pikePath).href;
    }

    return null;
  }

  /**
   * Resolve a sub-module within a resolved module.
   * If parent is a .pmod directory, look for child.pike, child.pmod, child.pmod/module.pmod.
   * If parent is a .pike file, sub-module doesn't apply (it's a program, not a module).
   */
  private async resolveSubModule(parentUri: string, segment: string): Promise<string | null> {
    const parentPath = fileURLToPath(parentUri);

    // If parent is a directory module, search inside it
    if (parentPath.endsWith(sep) || parentPath.endsWith("/")) {
      return this.findModuleInPath(segment, parentPath);
    }

    // If parent is module.pmod inside a .pmod directory, search the directory
    if (parentPath.endsWith("module.pmod")) {
      const parentDir = dirname(parentPath);
      return this.findModuleInPath(segment, parentDir);
    }

    // If parent is a .pmod file (not directory), it can't have sub-modules
    // If parent is a .pike file, sub-modules would be classes inside it
    // (handled by symbol table lookup, not file system resolution)
    return null;
  }

  /**
   * If the given file is inside a `.pmod/` directory, return the URI of its
   * `module.pmod` (the implicit directory-module inherit). See
   * resolveDirectoryModulePmod.
   */
  findDirectoryModulePmod(fileUri: string): Promise<string | null> {
    return resolveDirectoryModulePmod(fileUri);
  }

  /**
   * Evict oldest cache entries when the cache exceeds the maximum size.
   * Evicts 25% of entries to amortize the cost across multiple insertions.
   */
  private evictIfNeeded(): void {
    if (this.cache.size <= ModuleResolver.CACHE_MAX_ENTRIES) return;

    const evictCount = Math.ceil(ModuleResolver.CACHE_MAX_ENTRIES * 0.25);
    // Map iteration order is insertion order — oldest entries come first.
    let evicted = 0;
    for (const key of this.cache.keys()) {
      if (evicted >= evictCount) break;
      this.cache.delete(key);
      evicted++;
    }
  }
}
