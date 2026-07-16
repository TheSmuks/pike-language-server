/**
 * Internal helpers for ModuleResolver: filesystem probes, extension handling,
 * and `#include` path resolution. Extracted as free functions to keep
 * moduleResolver.ts focused on the class and under the file-length budget.
 */
import { join, dirname, resolve, basename, sep } from "node:path";
import { stat } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { ResolveResult } from "./moduleResolver";

/** File extensions we treat as Pike source / includable headers. */
const INCLUDABLE_EXTENSIONS = [".h", ".pike", ".pmod", ".inc"];

/** Strip surrounding `"..."` or `<...>` delimiters from an include path. */
export function stripIncludeDelimiters(pathText: string): string {
  return pathText.replace(/^["<]+|[">]+$/g, "");
}

/** Whether a path ends in a Pike source / header extension. */
function hasIncludableExtension(p: string): boolean {
  const lower = p.toLowerCase();
  return INCLUDABLE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

/** Check that a path exists on disk (file or directory). */
export async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { /* stat() throws if path doesn't exist */ return false; }
}

/** Check that a path exists and is a directory. */
export async function isDir(p: string): Promise<boolean> {
  try { const s = await stat(p); return s.isDirectory(); } catch { /* stat() throws if path doesn't exist */ return false; }
}

/** Check that a path exists and is a regular file. */
export async function isFile(p: string): Promise<boolean> {
  try { const s = await stat(p); return s.isFile(); } catch { /* stat() throws if path doesn't exist */ return false; }
}

/** Try to find a file with .pike or .pmod extension appended. */
export async function findWithExtension(basePath: string): Promise<string | null> {
  for (const ext of [".pike", ".pmod"]) {
    const candidate = basePath + ext;
    if (await pathExists(candidate)) return candidate;
  }
  return null;
}

/**
 * Context an include/relative resolution needs from the owning ModuleResolver.
 */
export interface IncludeDeps {
  /** Pike's configured -I include directories. */
  includePaths: string[];
  /** Normalized path if under an allowed root (workspace/pikeHome/module/include/program), else null. */
  checkRoot(path: string): string | null;
}

/**
 * Resolve a `#include` target to a file URI (uncached).
 * - `<file.h>` (isSystem): search the configured -I include directories.
 * - `"file.h"`: resolve relative to the current file's directory, allowing `../`
 *   traversal; absolute paths stay root-restricted.
 */
export async function resolveIncludeUncached(
  deps: IncludeDeps,
  pathText: string,
  isSystem: boolean,
  currentFile: string,
): Promise<ResolveResult | null> {
  const inner = stripIncludeDelimiters(pathText);
  if (inner.length === 0) return null;

  if (isSystem) {
    for (const dir of deps.includePaths) {
      const candidate = join(dir, inner);
      if (await isFile(candidate)) {
        return { uri: pathToFileURL(candidate).href, source: "system_module" };
      }
    }
    return null;
  }

  if (inner.startsWith("/")) {
    // Absolute path stays root-restricted (no upward traversal from a file).
    const checked = deps.checkRoot(inner);
    if (checked && await isFile(checked)) {
      return { uri: pathToFileURL(checked).href, source: "relative" };
    }
    return null;
  }

  // Relative include: resolve against the current file's directory, allowing
  // `../` traversal. Accept when the resolved file exists AND is either under an
  // allowed root or carries an includable extension — the latter lets a header
  // outside the workspace resolve while still refusing to slurp arbitrary system
  // files like `/etc/passwd`.
  const resolved = resolve(dirname(currentFile), inner);
  if (await isFile(resolved) && relativeTargetAllowed(deps, resolved)) {
    return { uri: pathToFileURL(resolved).href, source: "relative" };
  }
  return null;
}

/**
 * Boundary check for a relative include/inherit target resolved from a file's
 * own directory: permit any path under a known root, or any Pike/header source
 * file — matching what the Pike compiler itself reads — while excluding
 * non-source system files reached by upward traversal.
 */
export function relativeTargetAllowed(deps: IncludeDeps, normalizedPath: string): boolean {
  if (deps.checkRoot(normalizedPath)) return true;
  return hasIncludableExtension(normalizedPath);
}

/**
 * Resolve a relative inherit target (with optional extension append), applying
 * the relaxed boundary to whatever file is actually found. Permits
 * ancestor/sibling programs outside the workspace while refusing non-source
 * system files reached by upward traversal.
 */
export async function resolveRelativeInheritTarget(deps: IncludeDeps, resolvedBase: string): Promise<ResolveResult | null> {
  if (await pathExists(resolvedBase) && relativeTargetAllowed(deps, resolvedBase)) {
    return { uri: pathToFileURL(resolvedBase).href, source: "relative" };
  }
  const withExt = await findWithExtension(resolvedBase);
  if (withExt && relativeTargetAllowed(deps, withExt)) {
    return { uri: pathToFileURL(withExt).href, source: "relative" };
  }
  return null;
}

/**
 * Find a module named `name` within the given search path.
 * Tries directory module (.pmod/), then file module (.pmod), then .pike.
 * Priority: .pmod > .pike (same as Pike, minus .so).
 */
export async function findModuleInPath(name: string, searchPath: string): Promise<string | null> {
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
export async function resolveSubModule(parentUri: string, segment: string): Promise<string | null> {
  const parentPath = fileURLToPath(parentUri);

  // If parent is a directory module, search inside it
  if (parentPath.endsWith(sep) || parentPath.endsWith("/")) {
    return findModuleInPath(segment, parentPath);
  }

  // If parent is module.pmod inside a .pmod directory, search the directory
  if (parentPath.endsWith("module.pmod")) {
    const parentDir = dirname(parentPath);
    return findModuleInPath(segment, parentDir);
  }

  // If parent is a .pmod file (not directory), it can't have sub-modules
  // If parent is a .pike file, sub-modules would be classes inside it
  // (handled by symbol table lookup, not file system resolution)
  return null;
}

/**
 * If `fileUri` is inside a `.pmod/` directory, return the URI of `module.pmod`
 * in that directory (if it exists). In Pike, files inside a `Foo.pmod/`
 * directory automatically inherit from `Foo.pmod/module.pmod` — its symbols are
 * visible to siblings without explicit import/inherit. Returns `null` otherwise.
 */
export async function resolveDirectoryModulePmod(fileUri: string): Promise<string | null> {
  const filePath = fileURLToPath(fileUri);
  const dir = dirname(filePath);

  // Parent directory must be named `*.pmod`, and don't match module.pmod itself.
  if (!basename(dir).endsWith(".pmod")) return null;
  if (basename(filePath) === "module.pmod") return null;

  const modulePmodPath = join(dir, "module.pmod");
  return (await pathExists(modulePmodPath)) ? pathToFileURL(modulePmodPath).href : null;
}
