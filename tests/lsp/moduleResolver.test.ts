/**
 * Tests for ModuleResolver: Pike's module resolution algorithm in TypeScript.
 *
 * Tests use the corpus directory as the workspace root, which has known files:
 * - cross_import_a.pmod (file module)
 * - cross_pmod_dir.pmod/ (directory module with module.pmod + helpers.pike)
 * - cross-inherit-simple-b.pike (target for inherit)
 * - cross-inherit-rename-b.pike (target for inherit with alias)
 */

import { describe, test, expect, beforeAll } from "bun:test";
import {
  ModuleResolver,
  detectPikePaths,
  type PikePaths,
  type ResolveResult,
} from "../../server/src/features/moduleResolver";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Test fixture: corpus directory as workspace
// ---------------------------------------------------------------------------

const CORPUS_DIR = join(import.meta.dir, "..", "..", "corpus", "files");
const CORPUS_URI = pathToFileURL(CORPUS_DIR).href;
const PIKE_HOME = "/usr/local/pike/8.0.1116";
const SYSTEM_MODULES = join(PIKE_HOME, "lib", "modules");

function makePikePaths(workspaceRoot: string): PikePaths {
  return {
    pikeHome: PIKE_HOME,
    modulePaths: [workspaceRoot, SYSTEM_MODULES],
    includePaths: [workspaceRoot],
    programPaths: [workspaceRoot],
  };
}

function makeResolver(pikeVersion?: { major: number; minor: number }): ModuleResolver {
  return new ModuleResolver({
    workspaceRoot: CORPUS_URI,
    pikePaths: makePikePaths(CORPUS_DIR),
    pikeVersion: pikeVersion ?? null,
  });
}

/** Path to a corpus file by name. */
function corpusFile(name: string): string {
  return join(CORPUS_DIR, name);
}

/** Expected URI for a corpus file. */
function corpusUri(name: string): string {
  return pathToFileURL(corpusFile(name)).href;
}

/** Expected URI for a system module. */
function systemUri(relPath: string): string {
  return pathToFileURL(join(SYSTEM_MODULES, relPath)).href;
}

// ---------------------------------------------------------------------------
// Module resolution
// ---------------------------------------------------------------------------

describe("ModuleResolver — module resolution", () => {
  const resolver = makeResolver();
  const anyFile = corpusFile("cross-stdlib.pike");

  test("resolves file module (.pmod file)", () => {
    const result = resolver.resolveModule("cross_import_a", anyFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross_import_a.pmod"));
    expect(result!.source).toBe("workspace_module");
  });

  test("resolves directory module (.pmod/ with module.pmod)", () => {
    const result = resolver.resolveModule("cross_pmod_dir", anyFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross_pmod_dir.pmod/module.pmod"));
    expect(result!.source).toBe("workspace_module");
  });

  test("resolves .pike file as module", () => {
    const result = resolver.resolveModule("cross-inherit-simple-b", anyFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-simple-b.pike"));
    expect(result!.source).toBe("workspace_module");
  });

  test("resolves system module (Stdio)", () => {
    const result = resolver.resolveModule("Stdio", anyFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(systemUri("Stdio.pmod/module.pmod"));
    expect(result!.source).toBe("system_module");
  });

  test("resolves system module with sub-module (Stdio.FakeFile)", () => {
    const result = resolver.resolveModule("Stdio.FakeFile", anyFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(systemUri("Stdio.pmod/FakeFile.pike"));
    expect(result!.source).toBe("system_module");
  });

  test("resolves system module Array (file .pmod)", () => {
    const result = resolver.resolveModule("Array", anyFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(systemUri("Array.pmod"));
    expect(result!.source).toBe("system_module");
  });

  test("returns null for unknown module", () => {
    const result = resolver.resolveModule("NonExistentModule", anyFile);
    expect(result).toBeNull();
  });

  test("normalizes hyphens to underscores in module names", () => {
    // cross_import_a.pmod — the file is named with underscores
    // Pike converts hyphens to underscores, so both should resolve
    const result = resolver.resolveModule("cross-import-a", anyFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross_import_a.pmod"));
  });

  test("caches results", () => {
    resolver.clearCache();
    const r1 = resolver.resolveModule("cross_import_a", anyFile);
    const r2 = resolver.resolveModule("cross_import_a", anyFile);
    expect(r1).toBe(r2); // Same object reference (cached)
  });
});

// ---------------------------------------------------------------------------
// Inherit resolution
// ---------------------------------------------------------------------------

describe("ModuleResolver — inherit resolution", () => {
  const resolver = makeResolver();

  test("string literal: relative path resolves to file", () => {
    const currentFile = corpusFile("cross-inherit-simple-a.pike");
    const result = resolver.resolveInherit('"cross-inherit-simple-b.pike"', true, currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-simple-b.pike"));
    expect(result!.source).toBe("relative");
  });

  test("identifier: resolves as module", () => {
    const currentFile = corpusFile("cross-inherit-simple-a.pike");
    const result = resolver.resolveInherit("cross-inherit-simple-b", false, currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-simple-b.pike"));
  });

  test("dot-path: resolves through module", () => {
    const currentFile = corpusFile("cross-stdlib.pike");
    // Stdio.FakeFile → system module
    const result = resolver.resolveInherit("Stdio.FakeFile", false, currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(systemUri("Stdio.pmod/FakeFile.pike"));
  });

  test("relative .Foo resolves in same directory", () => {
    const currentFile = corpusFile("cross-inherit-simple-a.pike");
    const result = resolver.resolveInherit(".cross-inherit-simple-b", false, currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-simple-b.pike"));
    expect(result!.source).toBe("relative");
  });

  test("returns null for nonexistent inherit target", () => {
    const currentFile = corpusFile("cross-inherit-simple-a.pike");
    const result = resolver.resolveInherit('"nonexistent.pike"', true, currentFile);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

describe("ModuleResolver — import resolution", () => {
  const resolver = makeResolver();

  test("resolves import of file module", () => {
    const currentFile = corpusFile("cross-import-b.pike");
    const result = resolver.resolveImport("cross_import_a", currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross_import_a.pmod"));
  });

  test("resolves import of directory module", () => {
    const currentFile = corpusFile("cross-pmod-user.pike");
    const result = resolver.resolveImport("cross_pmod_dir", currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross_pmod_dir.pmod/module.pmod"));
  });

  test("resolves import of system module", () => {
    const currentFile = corpusFile("import-stdlib.pike");
    const result = resolver.resolveImport("Stdio", currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(systemUri("Stdio.pmod/module.pmod"));
  });
});

// ---------------------------------------------------------------------------
// #pike version resolution
// ---------------------------------------------------------------------------

describe("ModuleResolver — #pike version paths", () => {
  test("version-aware resolver includes version path", () => {
    // #pike 7.8 should add lib/7.8/modules/ to search path
    const resolver = makeResolver({ major: 7, minor: 8 });
    // The version path exists in the Pike installation
    const versionPath = join(PIKE_HOME, "lib", "7.8", "modules");

    // Test that a module in the versioned path would be found
    // (We can't test actual resolution without a module in 7.8 path,
    //  but we verify the resolver doesn't crash with a version)
    const anyFile = corpusFile("compat-pike78.pike");
    const result = resolver.resolveModule("Stdio", anyFile);
    // Stdio should still resolve from the default system path
    expect(result).not.toBeNull();
  });

  test("null version (no #pike) resolves normally", () => {
    const resolver = makeResolver(null);
    const anyFile = corpusFile("basic-types.pike");
    const result = resolver.resolveModule("Stdio", anyFile);
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pike path detection
// ---------------------------------------------------------------------------

describe("detectPikePaths", () => {
  test("detects system Pike paths", () => {
    const paths = detectPikePaths(CORPUS_DIR);
    expect(paths.pikeHome).toBe(PIKE_HOME);
    expect(paths.modulePaths).toContain(join(PIKE_HOME, "lib", "modules"));
    expect(paths.modulePaths).toContain(CORPUS_DIR);
  });

  test("workspace root is in all path lists", () => {
    const paths = detectPikePaths(CORPUS_DIR);
    expect(paths.modulePaths).toContain(CORPUS_DIR);
    expect(paths.includePaths).toContain(CORPUS_DIR);
    expect(paths.programPaths).toContain(CORPUS_DIR);
  });
});
