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

import { join, dirname, resolve, basename, sep } from "node:path";
import { stat } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";

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
   */
  private normalizeAndCheck(resolvedPath: string): string | null {
    const normalized = resolve(resolvedPath);
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
      // Absolute path — normalize and check boundary
      return this.tryInheritCandidate(this.normalizeAndCheck(rawPath));
    }
    if (rawPath.startsWith("./") || rawPath.startsWith("../")) {
      // Relative to current file — normalize and check boundary
      const resolved = resolve(currentDir, rawPath);
      return this.tryInheritCandidate(this.normalizeAndCheck(resolved));
    }
    // Pike's cast_to_program: search current dir first, then program paths
    return this.searchInheritProgramPaths(rawPath, currentDir);
  }

  private async tryInheritCandidate(candidate: string | null): Promise<ResolveResult | null> {
    if (!candidate) return null;
    if (await pathExists(candidate)) {
      return { uri: pathToFileURL(candidate).href, source: "relative" };
    }
    const withExt = await this.findWithExtension(candidate);
    if (withExt) {
      return { uri: pathToFileURL(withExt).href, source: "relative" };
    }
    return null;
  }

  private async searchInheritProgramPaths(rawPath: string, currentDir: string): Promise<ResolveResult | null> {
    // Search current dir first
    const relativeToDir = resolve(currentDir, rawPath);
    const checkedRelative = this.normalizeAndCheck(relativeToDir);
    if (checkedRelative) {
      if (await pathExists(checkedRelative)) {
        return { uri: pathToFileURL(checkedRelative).href, source: "relative" };
      }
      const withExtDir = await this.findWithExtension(checkedRelative);
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
      const found = await this.findWithExtension(checked);
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
   * Try to find a file with .pike or .pmod extension appended.
   */
  private async findWithExtension(basePath: string): Promise<string | null> {
    for (const ext of [".pike", ".pmod"]) {
      const candidate = basePath + ext;
      if (await pathExists(candidate)) return candidate;
    }
    return null;
  }

  /**
   * If the given file is inside a `.pmod/` directory, return the URI of
   * `module.pmod` in that directory (if it exists). In Pike, files inside a
   * `Foo.pmod/` directory automatically inherit from `Foo.pmod/module.pmod` —
   * its symbols are visible to siblings without explicit import/inherit.
   *
   * Returns `null` if the file is not inside a `.pmod/` directory or no
   * `module.pmod` exists.
   */
  async findDirectoryModulePmod(fileUri: string): Promise<string | null> {
    const filePath = fileURLToPath(fileUri);
    const dir = dirname(filePath);
    const dirName = basename(dir);

    // Parent directory must be named `*.pmod`.
    if (!dirName.endsWith(".pmod")) return null;

    // Don't match module.pmod itself — it doesn't inherit from itself.
    if (basename(filePath) === "module.pmod") return null;

    const modulePmodPath = join(dir, "module.pmod");
    if (await pathExists(modulePmodPath)) {
      return pathToFileURL(modulePmodPath).href;
    }

    return null;
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

// ---------------------------------------------------------------------------
// Async fs helpers (module-level)
// ---------------------------------------------------------------------------

/** Check that a path exists on disk (file or directory). */
async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { /* stat() throws if path doesn't exist */ return false; }
}

/** Check that a path exists and is a directory. */
async function isDir(p: string): Promise<boolean> {
  try { const s = await stat(p); return s.isDirectory(); } catch { /* stat() throws if path doesn't exist */ return false; }
}

/** Check that a path exists and is a regular file. */
async function isFile(p: string): Promise<boolean> {
  try { const s = await stat(p); return s.isFile(); } catch { /* stat() throws if path doesn't exist */ return false; }
}
