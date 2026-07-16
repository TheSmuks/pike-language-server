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
import { pikeAvailable, pikeHome } from "../helpers/pikeAvailable";
import {
  ModuleResolver,
  detectPikePaths,
  type PikePaths,
  type ResolveResult,
} from "../../server/src/features/moduleResolver";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Test fixture: corpus directory as workspace
// ---------------------------------------------------------------------------

const CORPUS_DIR = join(import.meta.dir, "..", "..", "corpus", "files");
const CORPUS_URI = pathToFileURL(CORPUS_DIR).href;
const PIKE_HOME = pikeHome ?? "/usr/local/pike/8.0.1116";
// Source build: $PIKE_HOME/lib/modules; Package layout: $PIKE_HOME/modules
const SYSTEM_MODULES = existsSync(join(PIKE_HOME, "lib", "modules"))
  ? join(PIKE_HOME, "lib", "modules")
  : join(PIKE_HOME, "modules");

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

  test("resolves file module (.pmod file)", async () => {
    const result = await resolver.resolveModule("cross_import_a", anyFile)
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross_import_a.pmod"));
    expect(result!.source).toBe("workspace_module");
  });

  test("resolves directory module (.pmod/ with module.pmod)", async () => {
    const result = await resolver.resolveModule("cross_pmod_dir", anyFile)
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross_pmod_dir.pmod/module.pmod"));
    expect(result!.source).toBe("workspace_module");
  });

  test("resolves .pike file as module", async () => {
    const result = await resolver.resolveModule("cross-inherit-simple-b", anyFile)
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-simple-b.pike"));
    expect(result!.source).toBe("workspace_module");
  });

  test("resolves system module (Stdio)", async () => {
    const result = await resolver.resolveModule("Stdio", anyFile)
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(systemUri("Stdio.pmod/module.pmod"));
    expect(result!.source).toBe("system_module");
  });

  test("resolves system module with sub-module (Stdio.FakeFile)", async () => {
    const result = await resolver.resolveModule("Stdio.FakeFile", anyFile)
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(systemUri("Stdio.pmod/FakeFile.pike"));
    expect(result!.source).toBe("system_module");
  });

  test("resolves system module Array (file .pmod)", async () => {
    const result = await resolver.resolveModule("Array", anyFile)
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(systemUri("Array.pmod"));
    expect(result!.source).toBe("system_module");
  });

  test("returns null for unknown module", async () => {
    const result = await resolver.resolveModule("NonExistentModule", anyFile)
    expect(result).toBeNull();
  });

  test("normalizes hyphens to underscores in module names", async () => {
    // cross_import_a.pmod — the file is named with underscores
    // Pike converts hyphens to underscores, so both should resolve
    const result = await resolver.resolveModule("cross-import-a", anyFile)
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross_import_a.pmod"));
  });

  test("caches results", async () => {
    resolver.clearCache();
    const r1 = await resolver.resolveModule("cross_import_a", anyFile);
    const r2 = await resolver.resolveModule("cross_import_a", anyFile);
    expect(r1).toBe(r2); // Same object reference (cached)
  });
});

// ---------------------------------------------------------------------------
// Inherit resolution
// ---------------------------------------------------------------------------

describe("ModuleResolver — inherit resolution", () => {
  const resolver = makeResolver();

  test("string literal: relative path resolves to file", async () => {
    const currentFile = corpusFile("cross-inherit-simple-a.pike");
    const result = await resolver.resolveInherit('"cross-inherit-simple-b.pike"', true, currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-simple-b.pike"));
    expect(result!.source).toBe("relative");
  });

  test("identifier: resolves as module", async () => {
    const currentFile = corpusFile("cross-inherit-simple-a.pike");
    const result = await resolver.resolveInherit("cross-inherit-simple-b", false, currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-simple-b.pike"));
  });

  test("dot-path: resolves through module", async () => {
    const currentFile = corpusFile("cross-stdlib.pike");
    // Stdio.FakeFile → system module
    const result = await resolver.resolveInherit("Stdio.FakeFile", false, currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(systemUri("Stdio.pmod/FakeFile.pike"));
  });

  test("relative .Foo resolves in same directory", async () => {
    const currentFile = corpusFile("cross-inherit-simple-a.pike");
    const result = await resolver.resolveInherit(".cross-inherit-simple-b", false, currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-simple-b.pike"));
    expect(result!.source).toBe("relative");
  });

  test("returns null for nonexistent inherit target", async () => {
    const currentFile = corpusFile("cross-inherit-simple-a.pike");
    const result = await resolver.resolveInherit('"nonexistent.pike"', true, currentFile);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Regression: file opened outside the workspace root
//
// Bug: opening a single Pike file that lives outside the open workspace folder
// left every cross-file `inherit` (and the symbols it brings in) unresolved —
// "dumb mode". normalizeAndCheck rejected the file's own directory because it
// was not under the workspace root or a system path. The importing file's own
// directory is always a valid resolution root, so siblings must still resolve;
// absolute-path traversal must still be blocked.
// ---------------------------------------------------------------------------

describe("ModuleResolver — file outside workspace root", () => {
  // Workspace root points somewhere unrelated to the corpus, so the corpus
  // files are "outside the workspace" exactly like the reported scenario.
  const OUTSIDE_WS = pathToFileURL("/tmp/unrelated-workspace").href;
  const resolver = new ModuleResolver({
    workspaceRoot: OUTSIDE_WS,
    pikePaths: {
      pikeHome: PIKE_HOME,
      modulePaths: ["/tmp/unrelated-workspace", SYSTEM_MODULES],
      includePaths: ["/tmp/unrelated-workspace"],
      programPaths: ["/tmp/unrelated-workspace"],
    },
    pikeVersion: null,
  });

  test("resolves a sibling inherit for a file outside the workspace", async () => {
    const currentFile = corpusFile("cross-inherit-simple-a.pike");
    const result = await resolver.resolveInherit("cross-inherit-simple-b", false, currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-simple-b.pike"));
  });

  test("resolves a relative .sibling inherit for a file outside the workspace", async () => {
    const currentFile = corpusFile("cross-inherit-simple-a.pike");
    const result = await resolver.resolveInherit(".cross-inherit-simple-b", false, currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross-inherit-simple-b.pike"));
  });

  test("still blocks absolute-path traversal outside all boundaries", async () => {
    const currentFile = corpusFile("cross-inherit-simple-a.pike");
    const result = await resolver.resolveInherit('"/etc/passwd"', true, currentFile);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

describe("ModuleResolver — import resolution", () => {
  const resolver = makeResolver();

  test("resolves import of file module", async () => {
    const currentFile = corpusFile("cross-import-b.pike");
    const result = await resolver.resolveImport("cross_import_a", currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross_import_a.pmod"));
  });

  test("resolves import of directory module", async () => {
    const currentFile = corpusFile("cross-pmod-user.pike");
    const result = await resolver.resolveImport("cross_pmod_dir", currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(corpusUri("cross_pmod_dir.pmod/module.pmod"));
  });

  test("resolves import of system module", async () => {
    const currentFile = corpusFile("import-stdlib.pike");
    const result = await resolver.resolveImport("Stdio", currentFile);
    expect(result).not.toBeNull();
    expect(result!.uri).toBe(systemUri("Stdio.pmod/module.pmod"));
  });
});

// ---------------------------------------------------------------------------
// #pike version resolution
// ---------------------------------------------------------------------------

describe("ModuleResolver — #pike version paths", () => {
  test("version-aware resolver includes version path", async () => {
    // #pike 7.8 should add lib/7.8/modules/ to search path
    const resolver = makeResolver({ major: 7, minor: 8 });
    // The version path exists in the Pike installation
    const versionPath = join(PIKE_HOME, "lib", "7.8", "modules");

    // Test that a module in the versioned path would be found
    // (We can't test actual resolution without a module in 7.8 path,
    //  but we verify the resolver doesn't crash with a version)
    const anyFile = corpusFile("compat-pike78.pike");
    const result = await resolver.resolveModule("Stdio", anyFile)
    // Stdio should still resolve from the default system path
    expect(result).not.toBeNull();
  });

  test("null version (no #pike) resolves normally", async () => {
    const resolver = makeResolver(null);
    const anyFile = corpusFile("basic-types.pike");
    const result = await resolver.resolveModule("Stdio", anyFile)
    expect(result).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pike path detection
// ---------------------------------------------------------------------------

describe.skipIf(!pikeAvailable)("detectPikePaths", () => {
  test("detects system Pike paths", async () => {
    const pikeBinary = process.env.PIKE_BINARY ?? "pike";
    const paths = await detectPikePaths(CORPUS_DIR, pikeBinary);
    // pikeHome may be null in CI source builds where --show-paths
    // output differs. Only assert exact match when we have a known pikeHome.
    if (pikeHome) {
      expect(paths.pikeHome).toBe(PIKE_HOME);
      expect(paths.modulePaths).toContain(SYSTEM_MODULES);
    }
    expect(paths.modulePaths).toContain(CORPUS_DIR);
  });

  test("workspace root is in all path lists", async () => {
    const pikeBinary = process.env.PIKE_BINARY ?? "pike";
    const paths = await detectPikePaths(CORPUS_DIR, pikeBinary);
    expect(paths.modulePaths).toContain(CORPUS_DIR);
    expect(paths.includePaths).toContain(CORPUS_DIR);
    expect(paths.programPaths).toContain(CORPUS_DIR);
  });

  // Regression: `pike --show-paths` pads its labels with dots to a fixed
  // column, so the dot count depends on the label's length:
  //
  //   Module path...: /usr/local/pike/8.0.1116/lib/modules   <- 3 dots
  //   Include path..: /usr/local/pike/8.0.1116/lib/include   <- 2 dots
  //
  // The parser matched a literal `...` for every label, so `Include path` and
  // `Program path` never matched. includePaths held nothing but the workspace
  // root and every `#include <stdio.h>` silently failed to resolve —
  // goto-definition fell through and returned the including file itself.
  //
  // The neighbouring override test cannot catch this: it guards its assertions
  // with `if (systemInclude)`, so it passed vacuously the whole time.
  test("detects the system include directory, so <stdio.h> can resolve", async () => {
    const pikeBinary = process.env.PIKE_BINARY ?? "pike";
    const paths = await detectPikePaths(CORPUS_DIR, pikeBinary);

    const systemIncludes = paths.includePaths.filter((p) => p !== CORPUS_DIR);
    expect(systemIncludes.length).toBeGreaterThan(0);

    // The detected directory must be the real one — it has to contain the
    // headers Pike ships, or resolution still returns null.
    expect(systemIncludes.some((p) => existsSync(join(p, "stdio.h")))).toBe(true);
  });

  test("resolves a system include to the real header on disk", async () => {
    const pikeBinary = process.env.PIKE_BINARY ?? "pike";
    const paths = await detectPikePaths(CORPUS_DIR, pikeBinary);
    const resolver = new ModuleResolver({
      workspaceRoot: pathToFileURL(CORPUS_DIR).href,
      pikePaths: paths,
      pikeVersion: null,
    });

    const result = await resolver.resolveInclude(
      "<stdio.h>",
      true,
      join(CORPUS_DIR, "any.pike"),
    );
    expect(result).not.toBeNull();
    expect(result!.uri).toContain("stdio.h");
  });

  test("includePaths override is prepended, not replacing auto-detected system paths", async () => {
    const pikeBinary = process.env.PIKE_BINARY ?? "pike";
    const detected = await detectPikePaths(CORPUS_DIR, pikeBinary);
    // The auto-detected system include dir (e.g. $PIKE_HOME/lib/include) must
    // survive an individual override so `<stdio.h>` still resolves.
    const systemInclude = detected.includePaths.find((p) => p !== CORPUS_DIR);

    const custom = "/tmp/custom-pike-includes";
    const withOverride = await detectPikePaths(CORPUS_DIR, pikeBinary, {
      includePaths: [custom],
    });
    expect(withOverride.includePaths).toContain(custom);
    expect(withOverride.includePaths).toContain(CORPUS_DIR);
    if (systemInclude) {
      expect(withOverride.includePaths).toContain(systemInclude);
    }
    // Custom path outranks the auto-detected system dir.
    if (systemInclude) {
      expect(withOverride.includePaths.indexOf(custom)).toBeLessThan(
        withOverride.includePaths.indexOf(systemInclude),
      );
    }
  });
});
