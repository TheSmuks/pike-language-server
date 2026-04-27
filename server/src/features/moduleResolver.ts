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
import { existsSync, statSync, readdirSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PikePaths {
  /** Pike installation root (e.g., "/usr/local/pike/8.0.1116"). */
  pikeHome: string;
  /** Module search paths (-M). Includes system + workspace paths. */
  modulePaths: string[];
  /** Include search paths (-I). */
  includePaths: string[];
  /** Program search paths (for inherit string resolution). */
  programPaths: string[];
}

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
  pikePaths: PikePaths;
  /** #pike version directive for the current file, if present. */
  pikeVersion: { major: number; minor: number } | null;
}

// ---------------------------------------------------------------------------
// ModuleResolver
// ---------------------------------------------------------------------------

export class ModuleResolver {
  private readonly workspaceRoot: string;
  private readonly pikePaths: PikePaths;
  private readonly pikeVersion: { major: number; minor: number } | null;
  /** Cache: module path → resolved URI. */
  private readonly cache = new Map<string, ResolveResult | null>();

  constructor(options: ModuleResolverOptions) {
    this.workspaceRoot = fileURLToPath(options.workspaceRoot);
    this.pikePaths = options.pikePaths;
    this.pikeVersion = options.pikeVersion;
  }

  /** Clear the resolution cache. */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Resolve a module path like "Stdio.File" or "cross_import_a".
   * Returns null if unresolvable.
   */
  resolveModule(modulePath: string, currentFile: string): ResolveResult | null {
    const cacheKey = `mod:${modulePath}:${currentFile}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const result = this.doResolveModule(modulePath, currentFile);
    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Resolve an inherit path.
   * - String literal: `inherit "file.pike"` → resolve as file path
   * - Identifier: `inherit Foo` → resolve as module
   * - Dot-path: `inherit Foo.Bar` → resolve module, find class
   * - Relative: `inherit .Foo` → resolve relative to current file dir
   */
  resolveInherit(pathText: string, isStringLiteral: boolean, currentFile: string): ResolveResult | null {
    const cacheKey = `inh:${pathText}:${isStringLiteral}:${currentFile}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) return cached;

    let result: ResolveResult | null;

    if (isStringLiteral) {
      // Strip quotes from string literal
      const rawPath = pathText.replace(/^"|"$/g, "");
      result = this.resolveInheritString(rawPath, currentFile);
    } else if (pathText.startsWith(".")) {
      // Relative: .Foo → Foo.pike/Foo.pmod in same directory
      const relativeName = pathText.slice(1);
      result = this.resolveRelativeModule(relativeName, currentFile);
    } else {
      // Identifier or dot-path: resolve as module
      result = this.resolveModule(pathText, currentFile);
    }

    this.cache.set(cacheKey, result);
    return result;
  }

  /**
   * Resolve an import path like "Stdio" or "Stdio.File".
   * Import brings all symbols from the module into scope.
   */
  resolveImport(importPath: string, currentFile: string): ResolveResult | null {
    // Import resolution is the same as module resolution
    return this.resolveModule(importPath, currentFile);
  }

  // ---------------------------------------------------------------------------
  // Internal: module resolution
  // ---------------------------------------------------------------------------

  private doResolveModule(modulePath: string, currentFile: string): ResolveResult | null {
    const segments = modulePath.split(".");
    if (segments.length === 0) return null;

    // Build the search paths for this file
    const searchPaths = this.getSearchPaths(currentFile);

    // Resolve first segment as a module/file
    const firstName = segments[0];
    // Pike converts hyphens to underscores in module names
    const normalizedName = firstName.replace(/-/g, "_");

    let currentUri: string | null = null;
    let source: ResolveResult["source"] = "not_found";

    // Search paths in order
    for (const searchPath of searchPaths) {
      // Try original name first, then normalized (hyphens→underscores)
      let found = this.findModuleInPath(firstName, searchPath);
      if (!found && normalizedName !== firstName) {
        found = this.findModuleInPath(normalizedName, searchPath);
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
      const segmentResult = this.resolveSubModule(currentUri, segment);
      if (!segmentResult) return null;
      currentUri = segmentResult;
    }

    return { uri: currentUri, source };
  }

  // ---------------------------------------------------------------------------
  // Internal: inherit resolution
  // ---------------------------------------------------------------------------

  private resolveInheritString(rawPath: string, currentFile: string): ResolveResult | null {
    const currentDir = dirname(currentFile);

    let candidate: string;
    if (rawPath.startsWith("/")) {
      // Absolute path
      candidate = rawPath;
    } else if (rawPath.startsWith("./") || rawPath.startsWith("../")) {
      // Relative to current file
      candidate = resolve(currentDir, rawPath);
    } else {
      // Pike's cast_to_program: search current dir first, then program paths
      const relativeToDir = resolve(currentDir, rawPath);
      if (existsSync(relativeToDir)) {
        return { uri: pathToFileURL(relativeToDir).href, source: "relative" };
      }
      const withExtDir = this.findWithExtension(relativeToDir);
      if (withExtDir) {
        return { uri: pathToFileURL(withExtDir).href, source: "relative" };
      }

      // Then search program paths
      for (const progPath of this.pikePaths.programPaths) {
        const full = resolve(progPath, rawPath);
        if (existsSync(full)) {
          return { uri: pathToFileURL(full).href, source: "workspace_program" };
        }
      }
      // Try with extensions
      for (const progPath of this.pikePaths.programPaths) {
        const found = this.findWithExtension(resolve(progPath, rawPath));
        if (found) {
          return { uri: pathToFileURL(found).href, source: "workspace_program" };
        }
      }
      return null;
    }

    if (existsSync(candidate)) {
      return { uri: pathToFileURL(candidate).href, source: "relative" };
    }

    // Try adding extension
    const withExt = this.findWithExtension(candidate);
    if (withExt) {
      return { uri: pathToFileURL(withExt).href, source: "relative" };
    }

    return null;
  }

  private resolveRelativeModule(name: string, currentFile: string): ResolveResult | null {
    const currentDir = dirname(currentFile);
    const found = this.findModuleInPath(name, currentDir);
    return found ? { uri: found, source: "relative" } : null;
  }

  // ---------------------------------------------------------------------------
  // Internal: path searching
  // ---------------------------------------------------------------------------

  /**
   * Get the ordered list of module search paths for the current file.
   * Includes #pike version-specific paths if applicable.
   */
  private getSearchPaths(currentFile: string): string[] {
    const paths: string[] = [];

    // 1. Current file's directory (for relative resolution)
    paths.push(dirname(currentFile));

    // 2. Workspace module paths
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
      if (existsSync(versionPath) && !paths.includes(versionPath)) {
        paths.push(versionPath);
      }
    }

    // 4. System module paths
    for (const sp of this.pikePaths.modulePaths) {
      if (!paths.includes(sp)) paths.push(sp);
    }

    return paths;
  }

  /**
   * Find a module named `name` within the given search path.
   * Tries directory module (.pmod/), then file module (.pmod), then .pike.
   * Priority: .pmod > .pike (same as Pike, minus .so).
   */
  private findModuleInPath(name: string, searchPath: string): string | null {
    // 1. Directory module: name.pmod/module.pmod
    const dirPath = join(searchPath, `${name}.pmod`);
    if (existsSync(dirPath) && statSync(dirPath).isDirectory()) {
      // Return the module.pmod if it exists, otherwise the directory itself
      const moduleFile = join(dirPath, "module.pmod");
      if (existsSync(moduleFile)) {
        return pathToFileURL(moduleFile).href;
      }
      // Directory module without module.pmod — still a valid module
      return pathToFileURL(dirPath + sep).href;
    }

    // 2. File module: name.pmod
    const fileModulePath = join(searchPath, `${name}.pmod`);
    if (existsSync(fileModulePath) && statSync(fileModulePath).isFile()) {
      return pathToFileURL(fileModulePath).href;
    }

    // 3. Pike file: name.pike
    const pikePath = join(searchPath, `${name}.pike`);
    if (existsSync(pikePath)) {
      return pathToFileURL(pikePath).href;
    }

    return null;
  }

  /**
   * Resolve a sub-module within a resolved module.
   * If parent is a .pmod directory, look for child.pike, child.pmod, child.pmod/module.pmod.
   * If parent is a .pike file, sub-module doesn't apply (it's a program, not a module).
   */
  private resolveSubModule(parentUri: string, segment: string): string | null {
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
  private findWithExtension(basePath: string): string | null {
    for (const ext of [".pike", ".pmod"]) {
      const candidate = basePath + ext;
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Factory: detect Pike paths from system
// ---------------------------------------------------------------------------

/**
 * Detect Pike installation paths from the running Pike binary.
 * Falls back to well-known paths.
 */
export function detectPikePaths(workspaceRoot: string): PikePaths {
  // Detect Pike home from `pike --show-paths` or well-known location
  let pikeHome = "/usr/local/pike/8.0.1116";

  // Check common locations
  const candidates = [
    "/usr/local/pike/8.0.1116",
    "/opt/pike/8.0.1116",
    "/usr/lib/pike/8.0.1116",
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      pikeHome = candidate;
      break;
    }
  }

  const systemModulePath = join(pikeHome, "lib", "modules");

  return {
    pikeHome,
    modulePaths: [
      workspaceRoot,
      systemModulePath,
    ],
    includePaths: [workspaceRoot],
    programPaths: [workspaceRoot],
  };
}
