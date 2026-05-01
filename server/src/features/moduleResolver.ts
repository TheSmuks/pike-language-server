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
import { stat, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
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
      if (await pathExists(relativeToDir)) {
        return { uri: pathToFileURL(relativeToDir).href, source: "relative" };
      }
      const withExtDir = await this.findWithExtension(relativeToDir);
      if (withExtDir) {
        return { uri: pathToFileURL(withExtDir).href, source: "relative" };
      }

      // Then search program paths
      for (const progPath of this.pikePaths.programPaths) {
        const full = resolve(progPath, rawPath);
        if (await pathExists(full)) {
          return { uri: pathToFileURL(full).href, source: "workspace_program" };
        }
      }
      // Try with extensions
      for (const progPath of this.pikePaths.programPaths) {
        const found = await this.findWithExtension(resolve(progPath, rawPath));
        if (found) {
          return { uri: pathToFileURL(found).href, source: "workspace_program" };
        }
      }
      return null;
    }

    if (await pathExists(candidate)) {
      return { uri: pathToFileURL(candidate).href, source: "relative" };
    }

    // Try adding extension
    const withExt = await this.findWithExtension(candidate);
    if (withExt) {
      return { uri: pathToFileURL(withExt).href, source: "relative" };
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
}

// ---------------------------------------------------------------------------
// Async fs helpers (module-level)
// ---------------------------------------------------------------------------

/** Check that a path exists on disk (file or directory). */
async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/** Check that a path exists and is a directory. */
async function isDir(p: string): Promise<boolean> {
  try { const s = await stat(p); return s.isDirectory(); } catch { return false; }
}

/** Check that a path exists and is a regular file. */
async function isFile(p: string): Promise<boolean> {
  try { const s = await stat(p); return s.isFile(); } catch { return false; }
}


// ---------------------------------------------------------------------------
// Factory: detect Pike paths from system
// ---------------------------------------------------------------------------

/**
 * Promisified execFile for async child process execution.
 */
const execFileAsync = (
  cmd: string,
  args: string[],
  opts: { timeout: number }
): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { ...opts, encoding: "utf-8" }, (err: Error | null, stdout: string, stderr: string) => {
      if (err) { reject(err); return; }
      resolve(stdout + stderr);
    });
  });

/**
 * Detect Pike installation paths from the running Pike binary.
 * Falls back to well-known paths.
 */
export async function detectPikePaths(workspaceRoot: string, pikeBinaryPath?: string): Promise<PikePaths> {
  const pike = pikeBinaryPath ?? "pike";
  let pikeHome = "";
  let systemModulePath = "";
  let includePath = "";
  let programPath = "";

  // Try to get actual paths from the Pike binary
  try {
    const output = await execFileAsync(pike, ["--show-paths"], { timeout: 5000 });

    for (const line of output.split("\n")) {
      const masterMatch = line.match(/^master\.pike\.\.\.\s*:\s*(.+)$/);
      if (masterMatch) {
        const masterPath = masterMatch[1].trim();
        // Source build layout: $PIKE_HOME/lib/master.pike
        // Package layout:      $PIKE_HOME/master.pike
        if (masterPath.endsWith("/lib/master.pike")) {
          pikeHome = dirname(dirname(masterPath));
        } else {
          pikeHome = dirname(masterPath);
        }
      }

      const moduleMatch = line.match(/^Module path\.\.\.\s*:\s*(.+)$/);
      if (moduleMatch) {
        systemModulePath = moduleMatch[1].trim();
        if (!pikeHome) {
          // Source build: $PIKE_HOME/lib/modules
          // Package layout: $PIKE_HOME/modules
          if (systemModulePath.endsWith("/lib/modules")) {
            pikeHome = dirname(dirname(systemModulePath));
          } else {
            pikeHome = dirname(systemModulePath);
          }
        }
      }

      const includeMatch = line.match(/^Include path\.\.\s*:\s*(.+)$/);
      if (includeMatch) {
        includePath = includeMatch[1].trim();
      }

      const programMatch = line.match(/^Program path\.\.\s*:\s*(.+)$/);
      if (programMatch) {
        programPath = programMatch[1].trim();
      }
    }
  } catch {
    // Pike binary not found or failed — fall through to heuristic detection
  }

  // Fallback: detect version from `pike --version` and check common locations
  if (!pikeHome) {
    let detectedVersion = "";
    try {
      const versionOutput = await execFileAsync(pike, ["--version"], { timeout: 5000 });
      const versionMatch = versionOutput.match(/Pike v(\d+\.\d+) release (\d+)/);
      if (versionMatch) {
        detectedVersion = `${versionMatch[1]}.${versionMatch[2]}`;
      }
    } catch {
      // Pike not available
    }

    if (detectedVersion) {
      const versionCandidates = [
        `/usr/local/pike/${detectedVersion}`,
        `/opt/pike/${detectedVersion}`,
        `/usr/lib/pike/${detectedVersion}`,
        `/opt/homebrew/opt/pike/${detectedVersion}`,
        `/usr/local/Cellar/pike/${detectedVersion}`,
      ];
      for (const candidate of versionCandidates) {
        if (await pathExists(candidate)) {
          pikeHome = candidate;
          break;
        }
      }
    }
  }

  // Final fallback: scan for any Pike version in well-known directories
  if (!pikeHome) {
    const scanDirs = ["/usr/local/pike", "/opt/pike", "/usr/lib/pike", "/opt/homebrew/opt/pike", "/usr/local/Cellar/pike"];
    for (const scanDir of scanDirs) {
      if (!(await isDir(scanDir))) continue;
      try {
        const entries = (await readdir(scanDir, { withFileTypes: true }))
          .filter(d => d.isDirectory())
          .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
        if (entries.length > 0) {
          pikeHome = join(scanDir, entries[0].name);
          break;
        }
      } catch {
        // Permission denied or similar — skip
      }
    }
  }

  if (!systemModulePath && pikeHome) {
    systemModulePath = join(pikeHome, "lib", "modules");
  }

  const modulePaths: string[] = [workspaceRoot];
  if (systemModulePath) {
    modulePaths.push(systemModulePath);
  }

  const includePaths: string[] = [workspaceRoot];
  if (includePath) {
    includePaths.push(includePath);
  }

  const programPaths: string[] = [workspaceRoot];
  if (programPath) {
    programPaths.push(programPath);
  }

  return {
    pikeHome,
    modulePaths,
    includePaths,
    programPaths,
  };
}

// ---------------------------------------------------------------------------
// Lazy singleton: cached Pike paths promise
// ---------------------------------------------------------------------------

let pikePathsPromise: Promise<PikePaths> | null = null;

/**
 * Get Pike installation paths (lazy, cached).
 * Safe to call repeatedly; the detection runs only once.
 */
export function getPikePaths(workspaceRoot: string, pikeBinaryPath?: string): Promise<PikePaths> {
  if (!pikePathsPromise) {
    pikePathsPromise = detectPikePaths(workspaceRoot, pikeBinaryPath);
  }
  return pikePathsPromise;
}