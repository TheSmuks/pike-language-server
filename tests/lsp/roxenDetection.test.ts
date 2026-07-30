/**
 * Tests for Roxen installation discovery.
 *
 * Two kinds of test here, deliberately:
 *
 *   - Synthetic trees in a temp directory, for the precedence rules. They can
 *     stage several installations at once, which no real machine offers.
 *   - The real Roxen tree, for the path derivation. A fixture would only prove
 *     detection matches the layout we imagined; these prove it matches the one
 *     Roxen ships. They skip when no Roxen is present — the majority case the
 *     feature is built for.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectRoxenPaths,
  deriveRoxenPaths,
  discoverInstalledRoxen,
  isRoxenTree,
  readRoxenVersion,
  getRoxenPaths,
  clearRoxenPathsCache,
} from "../../server/src/features/roxenDetection";
import { roxenAvailable, roxenHome } from "../helpers/roxenAvailable";

// ---------------------------------------------------------------------------
// Synthetic tree construction
// ---------------------------------------------------------------------------

/**
 * Build the minimum tree `isRoxenTree` accepts, plus a version.h declaring
 * `version`. Extra directories are created relative to the root, so a test can
 * stage the optional `local/` tree Roxen only puts on the path when it exists.
 */
function makeRoxenTree(root: string, version: string, extraDirs: string[] = []): string {
  mkdirSync(join(root, "server", "base_server"), { recursive: true });
  mkdirSync(join(root, "server", "etc", "include"), { recursive: true });
  mkdirSync(join(root, "server", "etc", "modules"), { recursive: true });
  writeFileSync(join(root, "server", "base_server", "roxen.pike"), "// roxen\n");
  writeFileSync(join(root, "server", "etc", "include", "module.h"), "// module.h\n");

  const [ver, build] = splitVersion(version);
  writeFileSync(
    join(root, "server", "etc", "include", "version.h"),
    `constant roxen_ver = "${ver}";\nconstant roxen_build = "${build}";\n`,
  );

  for (const dir of extraDirs) mkdirSync(join(root, dir), { recursive: true });
  return root;
}

function splitVersion(version: string): [string, string] {
  const parts = version.split(".");
  return parts.length >= 3 ? [parts.slice(0, 2).join("."), parts[2]!] : [version, "0"];
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "roxen-detect-"));
  clearRoxenPathsCache();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  clearRoxenPathsCache();
});

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

describe("isRoxenTree", () => {
  test("accepts a tree with both markers", async () => {
    makeRoxenTree(join(tmp, "roxen6"), "6.1.248");
    expect(await isRoxenTree(join(tmp, "roxen6"))).toBe(true);
  });

  test("rejects a tree with only roxen.pike", async () => {
    const root = join(tmp, "impostor");
    mkdirSync(join(root, "server", "base_server"), { recursive: true });
    writeFileSync(join(root, "server", "base_server", "roxen.pike"), "// not roxen\n");
    expect(await isRoxenTree(root)).toBe(false);
  });

  test("rejects a directory that does not exist", async () => {
    expect(await isRoxenTree(join(tmp, "nothing-here"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

describe("readRoxenVersion", () => {
  test("joins roxen_ver and roxen_build", async () => {
    makeRoxenTree(join(tmp, "roxen6"), "6.1.248");
    expect(await readRoxenVersion(join(tmp, "roxen6"))).toBe("6.1.248");
  });

  test("reports 0 when version.h is absent, so it never wins by accident", async () => {
    const root = join(tmp, "bare");
    mkdirSync(join(root, "server", "etc", "include"), { recursive: true });
    expect(await readRoxenVersion(root)).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe("detectRoxenPaths precedence", () => {
  test("an explicit path wins over an ancestor tree", async () => {
    const explicit = makeRoxenTree(join(tmp, "explicit"), "5.0.1");
    const workspace = join(tmp, "ancestor", "server", "modules", "mine");
    makeRoxenTree(join(tmp, "ancestor"), "6.1.248");
    mkdirSync(workspace, { recursive: true });

    const result = await detectRoxenPaths(workspace, { explicitPath: explicit });
    expect(result.source).toBe("explicit");
    expect(result.paths?.roxenHome).toBe(explicit);
  });

  test("pike.json wins over an ancestor tree", async () => {
    const declared = makeRoxenTree(join(tmp, "declared"), "5.0.1");
    const workspace = join(tmp, "ws");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "pike.json"), JSON.stringify({ roxen: declared }));

    const result = await detectRoxenPaths(workspace);
    expect(result.source).toBe("pike_json");
    expect(result.paths?.roxenHome).toBe(declared);
  });

  test("pike.json accepts a path relative to the workspace", async () => {
    const workspace = join(tmp, "ws");
    mkdirSync(workspace, { recursive: true });
    makeRoxenTree(join(workspace, "vendor", "roxen"), "6.1.248");
    writeFileSync(join(workspace, "pike.json"), JSON.stringify({ roxen: { path: "vendor/roxen" } }));

    const result = await detectRoxenPaths(workspace);
    expect(result.source).toBe("pike_json");
    expect(result.paths?.roxenHome).toBe(join(workspace, "vendor", "roxen"));
  });

  test("an ancestor of the workspace is found when nothing is configured", async () => {
    const install = makeRoxenTree(join(tmp, "roxen6"), "6.1.248");
    const workspace = join(install, "server", "modules", "filesystems");
    mkdirSync(workspace, { recursive: true });

    const result = await detectRoxenPaths(workspace);
    expect(result.source).toBe("workspace_ancestor");
    expect(result.paths?.roxenHome).toBe(install);
  });

  test("filesystem discovery selects the highest version among several", async () => {
    const roots = join(tmp, "usr-local");
    mkdirSync(roots, { recursive: true });
    makeRoxenTree(join(roots, "roxen5"), "5.2.900");
    makeRoxenTree(join(roots, "roxen6"), "6.1.248");
    makeRoxenTree(join(roots, "roxen4"), "4.5.100");

    expect(await discoverInstalledRoxen([{ dir: roots, prefix: "roxen" }]))
      .toBe(join(roots, "roxen6"));
  });

  test("filesystem discovery compares versions numerically, not lexically", async () => {
    const roots = join(tmp, "usr-local");
    mkdirSync(roots, { recursive: true });
    makeRoxenTree(join(roots, "roxen6a"), "6.1.90");
    makeRoxenTree(join(roots, "roxen6b"), "6.1.248");

    // "248" sorts before "90" as text; the higher build must still win.
    expect(await discoverInstalledRoxen([{ dir: roots, prefix: "roxen" }]))
      .toBe(join(roots, "roxen6b"));
  });

  test("filesystem discovery ignores prefixed directories that are not Roxen", async () => {
    const roots = join(tmp, "usr-local");
    mkdirSync(join(roots, "roxen-notes"), { recursive: true });
    makeRoxenTree(join(roots, "roxen6"), "6.1.248");

    expect(await discoverInstalledRoxen([{ dir: roots, prefix: "roxen" }]))
      .toBe(join(roots, "roxen6"));
  });

  test("filesystem discovery is the last resort, below an ancestor tree", async () => {
    const roots = join(tmp, "usr-local");
    mkdirSync(roots, { recursive: true });
    makeRoxenTree(join(roots, "roxen6"), "6.1.248");
    const ancestor = makeRoxenTree(join(tmp, "checkout"), "5.0.1");
    const workspace = join(ancestor, "server", "modules", "mine");
    mkdirSync(workspace, { recursive: true });

    const result = await detectRoxenPaths(workspace, {
      discoveryRoots: [{ dir: roots, prefix: "roxen" }],
    });
    expect(result.source).toBe("workspace_ancestor");
    expect(result.paths?.roxenHome).toBe(ancestor);
  });

  test("filesystem discovery is used when nothing else matches", async () => {
    const roots = join(tmp, "usr-local");
    mkdirSync(roots, { recursive: true });
    const install = makeRoxenTree(join(roots, "roxen6"), "6.1.248");
    const workspace = join(tmp, "ws");
    mkdirSync(workspace, { recursive: true });

    const result = await detectRoxenPaths(workspace, {
      discoveryRoots: [{ dir: roots, prefix: "roxen" }],
    });
    expect(result.source).toBe("filesystem");
    expect(result.paths?.roxenHome).toBe(install);
  });

  test("absence is reported without error", async () => {
    const workspace = join(tmp, "plain-pike");
    mkdirSync(workspace, { recursive: true });

    // No discovery roots: the machine running this may itself have a Roxen
    // installed, and that must not decide the outcome of an absence test.
    const result = await detectRoxenPaths(workspace, { discoveryRoots: [] });
    expect(result.paths).toBeNull();
    expect(result.source).toBe("absent");
    expect(result.misconfiguredPath).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Misconfiguration
// ---------------------------------------------------------------------------

describe("detectRoxenPaths misconfiguration", () => {
  test("a configured path with no Roxen tree falls through and is reported", async () => {
    const install = makeRoxenTree(join(tmp, "roxen6"), "6.1.248");
    const workspace = join(install, "server", "modules", "mine");
    mkdirSync(workspace, { recursive: true });
    const bogus = join(tmp, "not-roxen");
    mkdirSync(bogus, { recursive: true });

    const result = await detectRoxenPaths(workspace, { explicitPath: bogus });
    expect(result.misconfiguredPath).toBe(bogus);
    // Falls through rather than disabling the feature outright.
    expect(result.source).toBe("workspace_ancestor");
    expect(result.paths?.roxenHome).toBe(install);
  });

  test("a bad configured path with nothing else still reports absence, not an error", async () => {
    const workspace = join(tmp, "ws");
    mkdirSync(workspace, { recursive: true });

    const result = await detectRoxenPaths(workspace, {
      explicitPath: join(tmp, "nowhere"),
      discoveryRoots: [],
    });
    expect(result.paths).toBeNull();
    expect(result.source).toBe("absent");
    expect(result.misconfiguredPath).toBe(join(tmp, "nowhere"));
  });
});

// ---------------------------------------------------------------------------
// Path derivation
// ---------------------------------------------------------------------------

describe("deriveRoxenPaths", () => {
  test("omits optional local/ directories that do not exist", async () => {
    const install = makeRoxenTree(join(tmp, "roxen6"), "6.1.248");
    const paths = await deriveRoxenPaths(install);

    expect(paths.modulePaths).toEqual([join(install, "server", "etc", "modules")]);
    expect(paths.includePaths).toEqual([
      join(install, "server", "etc", "include"),
      join(install, "server", "base_server"),
    ]);
    expect(paths.programPaths).toEqual([
      join(install, "server", "base_server"),
      join(install, "server"),
    ]);
  });

  test("includes local/ directories when present, in Roxen's own order", async () => {
    const install = makeRoxenTree(join(tmp, "roxen6"), "6.1.248", [
      "local/pike_modules",
      "local/include",
      "local/base_server",
    ]);
    const paths = await deriveRoxenPaths(install);

    expect(paths.modulePaths).toEqual([
      join(install, "server", "etc", "modules"),
      join(install, "local", "pike_modules"),
    ]);
    // local/include precedes base_server, matching how Roxen assembles -I.
    expect(paths.includePaths).toEqual([
      join(install, "server", "etc", "include"),
      join(install, "local", "include"),
      join(install, "server", "base_server"),
      join(install, "local", "base_server"),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

describe("getRoxenPaths", () => {
  test("returns the same promise for the same inputs", async () => {
    const workspace = join(tmp, "ws");
    mkdirSync(workspace, { recursive: true });
    expect(getRoxenPaths(workspace)).toBe(getRoxenPaths(workspace));
  });

  test("re-detects when the configured path changes", async () => {
    const workspace = join(tmp, "ws");
    mkdirSync(workspace, { recursive: true });
    const first = getRoxenPaths(workspace);
    const second = getRoxenPaths(workspace, { explicitPath: join(tmp, "elsewhere") });
    expect(first).not.toBe(second);
    await Promise.all([first, second]); // Neither may reject.
  });
});

// ---------------------------------------------------------------------------
// Against the real thing
// ---------------------------------------------------------------------------

describe.skipIf(!roxenAvailable)("detection against a real Roxen tree", () => {
  test("recognises it and reads its version", async () => {
    expect(await isRoxenTree(roxenHome!)).toBe(true);
    expect(await readRoxenVersion(roxenHome!)).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("derives paths that exist and hold the Roxen headers", async () => {
    const paths = await deriveRoxenPaths(roxenHome!);

    for (const p of [...paths.modulePaths, ...paths.includePaths, ...paths.programPaths]) {
      expect(existsSync(p)).toBe(true);
    }
    // The whole point of the include path: module.h must be reachable on it.
    const found = paths.includePaths.some((p) => existsSync(join(p, "module.h")));
    expect(found).toBe(true);
  });

  test("finds the installation from a module directory inside it", async () => {
    const moduleDir = join(roxenHome!, "server", "modules", "filesystems");
    if (!existsSync(moduleDir)) return; // Layout differs; the other tests still apply.

    const result = await detectRoxenPaths(moduleDir);
    expect(result.source).toBe("workspace_ancestor");
    expect(result.paths?.roxenHome).toBe(roxenHome!);
  });
});
