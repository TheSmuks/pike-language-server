/**
 * Tests for Roxen resolution: the `roxen-module://` scheme, Roxen headers, and
 * the module prototype.
 *
 * Each behaviour is exercised twice — with a detected installation and without
 * one — because "without" is the majority case and the one where a mistake is
 * silent. Resolution failing there is correct; failing loudly is not.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { ModuleResolver, type PikePaths } from "../../server/src/features/moduleResolver";
import { deriveRoxenPaths, type RoxenPaths } from "../../server/src/features/roxenDetection";
import {
  ROXEN_MODULE_SCHEME,
  isRoxenScheme,
  mergeRoxenIntoPikePaths,
  resolveRoxenModuleUri,
} from "../../server/src/features/roxenResolution";
import { roxenAvailable, roxenHome } from "../helpers/roxenAvailable";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "roxen-resolve-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** A workspace holding one Roxen-looking file, used as the resolution origin. */
function makeWorkspace(): { root: string; file: string } {
  const root = join(tmp, "ws");
  mkdirSync(root, { recursive: true });
  const file = join(root, "mymodule.pike");
  writeFileSync(file, '#include <module.h>\ninherit "module";\n');
  return { root, file };
}

function makePikePaths(root: string): PikePaths {
  return {
    pikeHome: "",
    modulePaths: [root],
    includePaths: [root],
    programPaths: [root],
    ldLibraryPath: "",
  };
}

function makeResolver(root: string, roxen: RoxenPaths | null): ModuleResolver {
  const base = makePikePaths(root);
  return new ModuleResolver({
    workspaceRoot: pathToFileURL(root).href,
    pikePaths: roxen ? mergeRoxenIntoPikePaths(base, roxen) : base,
    pikeVersion: null,
    ...(roxen ? { roxenModuleDirs: roxen.moduleDirs } : {}),
  });
}

/** Build a minimal but structurally real Roxen tree under `tmp`. */
function makeRoxenInstall(): string {
  const home = join(tmp, "roxen6");
  mkdirSync(join(home, "server", "base_server"), { recursive: true });
  mkdirSync(join(home, "server", "etc", "include"), { recursive: true });
  mkdirSync(join(home, "server", "etc", "modules"), { recursive: true });
  mkdirSync(join(home, "server", "modules", "filesystems"), { recursive: true });

  writeFileSync(join(home, "server", "base_server", "roxen.pike"), "// roxen\n");
  writeFileSync(join(home, "server", "base_server", "module.pike"), "// the module prototype\n");
  writeFileSync(join(home, "server", "etc", "include", "module.h"), "#define TYPE_STRING 1\n");
  writeFileSync(join(home, "server", "etc", "include", "roxen.h"), "// roxen.h\n");
  writeFileSync(join(home, "server", "etc", "include", "version.h"), 'constant roxen_ver = "6.1";\nconstant roxen_build = "248";\n');
  writeFileSync(join(home, "server", "modules", "filesystems", "filesystem.pike"), "// filesystem module\n");
  return home;
}

// ---------------------------------------------------------------------------
// Scheme recognition
// ---------------------------------------------------------------------------

describe("isRoxenScheme", () => {
  test("recognises both Roxen URI schemes", () => {
    expect(isRoxenScheme("roxen-module://filesystem")).toBe(true);
    expect(isRoxenScheme("roxen-path://$LOCALDIR/foo")).toBe(true);
  });

  test("does not claim ordinary inherit targets", () => {
    expect(isRoxenScheme("module")).toBe(false);
    expect(isRoxenScheme("./sibling.pike")).toBe(false);
    expect(isRoxenScheme("/abs/path.pike")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// roxen-module:// with an installation
// ---------------------------------------------------------------------------

describe("roxen-module:// with a detected installation", () => {
  test("resolves to the module file", async () => {
    const home = makeRoxenInstall();
    const roxen = await deriveRoxenPaths(home);
    const { root, file } = makeWorkspace();
    const resolver = makeResolver(root, roxen);

    const result = await resolver.resolveInherit('"roxen-module://filesystem"', true, file);
    expect(result).not.toBeNull();
    expect(fileURLToPath(result!.uri)).toBe(join(home, "server", "modules", "filesystems", "filesystem.pike"));
    expect(result!.source).toBe("roxen_module");
  });

  test("returns null for a module the installation does not have", async () => {
    const roxen = await deriveRoxenPaths(makeRoxenInstall());
    const { root, file } = makeWorkspace();
    const resolver = makeResolver(root, roxen);

    expect(await resolver.resolveInherit('"roxen-module://nonexistent"', true, file)).toBeNull();
  });

  test("prefers a local/ module over the stock one, as Roxen does", async () => {
    const home = makeRoxenInstall();
    mkdirSync(join(home, "local", "modules"), { recursive: true });
    writeFileSync(join(home, "local", "modules", "filesystem.pike"), "// override\n");
    const roxen = await deriveRoxenPaths(home);

    const uri = await resolveRoxenModuleUri(roxen.moduleDirs, "roxen-module://filesystem");
    expect(fileURLToPath(uri!)).toBe(join(home, "local", "modules", "filesystem.pike"));
  });

  test("skips a module Roxen itself would refuse (#!NO marker)", async () => {
    const home = makeRoxenInstall();
    writeFileSync(join(home, "server", "modules", "disabled.pike"), "#!NO this module is parked\n");
    const roxen = await deriveRoxenPaths(home);

    expect(await resolveRoxenModuleUri(roxen.moduleDirs, "roxen-module://disabled")).toBeNull();
  });

  test("refuses a name containing a path separator", async () => {
    const roxen = await deriveRoxenPaths(makeRoxenInstall());
    expect(await resolveRoxenModuleUri(roxen.moduleDirs, "roxen-module://../../etc/passwd")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// roxen-module:// without an installation
// ---------------------------------------------------------------------------

describe("roxen-module:// without an installation", () => {
  test("resolves to nothing, and does not throw", async () => {
    const { root, file } = makeWorkspace();
    const resolver = makeResolver(root, null);

    expect(await resolver.resolveInherit('"roxen-module://filesystem"', true, file)).toBeNull();
  });

  test("is not mistaken for a relative filesystem path", async () => {
    // Without interception the scheme reads as the directory `roxen-module:`
    // followed by `/filesystem`, which is both wrong and a way out of the
    // workspace. Staging that directory proves the interception happens.
    const { root, file } = makeWorkspace();
    mkdirSync(join(root, "roxen-module:"), { recursive: true });
    writeFileSync(join(root, "roxen-module:", "filesystem.pike"), "// decoy\n");
    const resolver = makeResolver(root, null);

    expect(await resolver.resolveInherit('"roxen-module://filesystem"', true, file)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// roxen-path://
// ---------------------------------------------------------------------------

describe("roxen-path://", () => {
  test("is left unresolved rather than treated as a path", async () => {
    const roxen = await deriveRoxenPaths(makeRoxenInstall());
    const { root, file } = makeWorkspace();
    const resolver = makeResolver(root, roxen);

    expect(await resolver.resolveInherit('"roxen-path://$LOCALDIR/x.pike"', true, file)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Roxen headers
// ---------------------------------------------------------------------------

describe("Roxen headers", () => {
  test("#include <module.h> resolves against the installation", async () => {
    const home = makeRoxenInstall();
    const roxen = await deriveRoxenPaths(home);
    const { root, file } = makeWorkspace();
    const resolver = makeResolver(root, roxen);

    const result = await resolver.resolveInclude("module.h", true, file);
    expect(result).not.toBeNull();
    expect(fileURLToPath(result!.uri)).toBe(join(home, "server", "etc", "include", "module.h"));
  });

  test("#include <module.h> resolves to nothing without an installation", async () => {
    const { root, file } = makeWorkspace();
    const resolver = makeResolver(root, null);

    expect(await resolver.resolveInclude("module.h", true, file)).toBeNull();
  });

  test("an include whose path is a macro rather than a literal stays unresolved", async () => {
    const roxen = await deriveRoxenPaths(makeRoxenInstall());
    const { root, file } = makeWorkspace();
    const resolver = makeResolver(root, roxen);

    // Nothing on any search path is named after the macro, so resolution
    // reports nothing. The requirement is that it is quiet about it.
    expect(await resolver.resolveInclude("SOME_HEADER_MACRO", true, file)).toBeNull();
    expect(await resolver.resolveInclude("%s", true, file)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The module prototype
// ---------------------------------------------------------------------------

describe('inherit "module"', () => {
  test("resolves to the module prototype in the installation", async () => {
    const home = makeRoxenInstall();
    const roxen = await deriveRoxenPaths(home);
    const { root, file } = makeWorkspace();
    const resolver = makeResolver(root, roxen);

    const result = await resolver.resolveInherit('"module"', true, file);
    expect(result).not.toBeNull();
    expect(fileURLToPath(result!.uri)).toBe(join(home, "server", "base_server", "module.pike"));
  });

  test("resolves to nothing without an installation", async () => {
    const { root, file } = makeWorkspace();
    const resolver = makeResolver(root, null);

    expect(await resolver.resolveInherit('"module"', true, file)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Path merging
// ---------------------------------------------------------------------------

describe("mergeRoxenIntoPikePaths", () => {
  test("appends Roxen paths so workspace files still shadow the installation", async () => {
    const roxen = await deriveRoxenPaths(makeRoxenInstall());
    const base = makePikePaths("/ws");

    const merged = mergeRoxenIntoPikePaths(base, roxen);
    expect(merged.includePaths[0]).toBe("/ws");
    expect(merged.includePaths).toContain(roxen.includePaths[0]!);
    expect(merged.pikeHome).toBe(base.pikeHome);
  });

  test("does not duplicate a path already present", async () => {
    const roxen = await deriveRoxenPaths(makeRoxenInstall());
    const base: PikePaths = { ...makePikePaths("/ws"), includePaths: ["/ws", roxen.includePaths[0]!] };

    const merged = mergeRoxenIntoPikePaths(base, roxen);
    expect(merged.includePaths.filter((p) => p === roxen.includePaths[0]!)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Against the real installation
// ---------------------------------------------------------------------------

describe.skipIf(!roxenAvailable)("resolution against a real Roxen tree", () => {
  test("resolves the thirteen shipped headers", async () => {
    const roxen = await deriveRoxenPaths(roxenHome!);
    const { root, file } = makeWorkspace();
    const resolver = makeResolver(root, roxen);

    // The headers the corpus actually includes, by measured frequency.
    const headers = [
      "module.h", "roxen.h", "config.h", "module_constants.h",
      "request_trace.h", "config_interface.h", "variables.h",
      "security.h", "stat.h", "timers.h", "udp.h", "version.h", "testsuite.h",
    ];
    for (const header of headers) {
      const result = await resolver.resolveInclude(header, true, file);
      expect(result, `#include <${header}> must resolve`).not.toBeNull();
    }
  });

  test('resolves inherit "module" to base_server/module.pike', async () => {
    const roxen = await deriveRoxenPaths(roxenHome!);
    const { root, file } = makeWorkspace();
    const resolver = makeResolver(root, roxen);

    const result = await resolver.resolveInherit('"module"', true, file);
    expect(result).not.toBeNull();
    expect(fileURLToPath(result!.uri)).toBe(join(roxenHome!, "server", "base_server", "module.pike"));
  });

  test("resolves the roxen-module:// target the corpus actually uses", async () => {
    const roxen = await deriveRoxenPaths(roxenHome!);
    // server/modules/js-support/yui.pike and scripting/webapp.pike both do
    // `inherit "roxen-module://filesystem"`.
    const uri = await resolveRoxenModuleUri(roxen.moduleDirs, `${ROXEN_MODULE_SCHEME}filesystem`);
    expect(uri).not.toBeNull();
    expect(fileURLToPath(uri!)).toBe(
      join(roxenHome!, "server", "modules", "filesystems", "filesystem.pike"),
    );
  });
});
