/**
 * Tests for Roxen mode activation.
 *
 * The coverage claim this feature rests on — that the three marker families
 * plus directory inheritance account for every file in Roxen's own module tree
 * — is checked here against the real corpus, not asserted in prose.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ROXEN_MODE,
  clearRoxenActivationCache,
  hasRoxenMarker,
  isRoxenFile,
  isRoxenMode,
  type RoxenActivationContext,
} from "../../server/src/features/roxenActivation";
import { roxenAvailable, roxenHome } from "../helpers/roxenAvailable";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "roxen-activate-"));
  clearRoxenActivationCache();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  clearRoxenActivationCache();
});

function ctx(overrides: Partial<RoxenActivationContext> = {}): RoxenActivationContext {
  return { mode: "auto", roxenHome: null, workspaceRoot: tmp, ...overrides };
}

/** Write a file, creating its directory. Returns the path. */
function write(relPath: string, contents: string): string {
  const full = join(tmp, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
  return full;
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

describe("hasRoxenMarker", () => {
  test("matches each of the three marker families", () => {
    expect(hasRoxenMarker("#include <module.h>\n")).toBe(true);
    expect(hasRoxenMarker('inherit "module";\n')).toBe(true);
    expect(hasRoxenMarker("constant module_type = MODULE_LOCATION;\n")).toBe(true);
  });

  test("matches every activation header", () => {
    for (const header of ["module.h", "roxen.h", "config.h", "module_constants.h", "request_trace.h", "config_interface.h"]) {
      expect(hasRoxenMarker(`#include <${header}>\n`), header).toBe(true);
    }
  });

  test("tolerates the spacing the corpus actually uses", () => {
    // modules/security/htaccess.pike writes `# include <request_trace.h>`.
    expect(hasRoxenMarker("# include <request_trace.h>\n")).toBe(true);
    expect(hasRoxenMarker("  #include\t<module.h>\n")).toBe(true);
    expect(hasRoxenMarker("constant  module_type =  MODULE_TAG | MODULE_PARSER;\n")).toBe(true);
  });

  test("does not match plain Pike", () => {
    expect(hasRoxenMarker("#include <stdio.h>\nint main(){ return 0; }\n")).toBe(false);
    expect(hasRoxenMarker('inherit "other";\n')).toBe(false);
    expect(hasRoxenMarker("constant module_type = 1;\n")).toBe(false);
    expect(hasRoxenMarker("int MODULE_LOCATION = 1;\n")).toBe(false);
  });

  test("does not match a header with a Roxen-like name in a longer path", () => {
    expect(hasRoxenMarker("#include <mystuff/module.h>\n")).toBe(false);
  });
});

describe("isRoxenMode", () => {
  test("accepts exactly the three documented values", () => {
    expect(isRoxenMode("auto")).toBe(true);
    expect(isRoxenMode("on")).toBe(true);
    expect(isRoxenMode("off")).toBe(true);
    expect(isRoxenMode("yes")).toBe(false);
    expect(isRoxenMode(undefined)).toBe(false);
  });

  test("defaults to auto", () => {
    expect(DEFAULT_ROXEN_MODE).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// The setting
// ---------------------------------------------------------------------------

describe("pike.roxen.mode", () => {
  test("on activates a file with no markers at all", async () => {
    const file = write("plain.pike", "int main(){ return 0; }\n");
    expect(await isRoxenFile(file, null, ctx({ mode: "on" }))).toBe(true);
  });

  test("off deactivates a file inside a detected installation", async () => {
    const file = write("roxen6/server/modules/x.pike", "#include <module.h>\n");
    expect(await isRoxenFile(file, null, ctx({ mode: "off", roxenHome: join(tmp, "roxen6") }))).toBe(false);
  });

  test("auto is the tier-based behaviour", async () => {
    // Both files sit in their own subdirectory so that neither is a sibling or
    // descendant of the other — a marked file at the workspace ROOT would
    // legitimately activate the whole workspace by inheritance.
    const marked = write("roxen/marked.pike", "#include <module.h>\n");
    const plain = write("elsewhere/plain.pike", "int main(){ return 0; }\n");
    expect(await isRoxenFile(marked, null, ctx())).toBe(true);
    expect(await isRoxenFile(plain, null, ctx())).toBe(false);
  });

  test("a marked file at the workspace root activates the workspace", async () => {
    // Documented consequence of the inheritance rule rather than an accident:
    // the workspace root is an ancestor directory of everything in it.
    write("mod.pike", "#include <module.h>\n");
    const nested = write("sub/deep/helper.pike", "int f(){ return 1; }\n");
    expect(await isRoxenFile(nested, null, ctx())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Directory inheritance
// ---------------------------------------------------------------------------

describe("directory inheritance", () => {
  test("a marker-less file beside a marked one is a Roxen file", async () => {
    write("mod/real.pike", 'inherit "module";\n');
    const helper = write("mod/helper.pike", "int helper(){ return 1; }\n");
    expect(await isRoxenFile(helper, null, ctx())).toBe(true);
  });

  test("a plugin inherits from an ancestor directory, as the corpus requires", async () => {
    // This is the shape of graphics/rimage: rimage.pike carries the markers,
    // and its plugins/ subdirectory carries none.
    write("graphics/rimage/rimage.pike", "#include <module.h>\nconstant module_type = MODULE_TAG;\n");
    const plugin = write("graphics/rimage/plugins/scale.pike", "void plugin(){}\n");
    expect(await isRoxenFile(plugin, null, ctx())).toBe(true);
  });

  test("a plain file in an unrelated tree is not a Roxen file", async () => {
    write("roxenish/mod.pike", "#include <module.h>\n");
    const plain = write("plainpike/util.pike", "int add(int a, int b){ return a + b; }\n");
    expect(await isRoxenFile(plain, null, ctx())).toBe(false);
  });

  test("the walk stops at the workspace root", async () => {
    // A marked file ABOVE the workspace must not activate anything inside it.
    write("marked.pike", "#include <module.h>\n");
    const inner = join(tmp, "project");
    mkdirSync(inner, { recursive: true });
    const plain = write("project/util.pike", "int f(){ return 1; }\n");
    expect(await isRoxenFile(plain, null, ctx({ workspaceRoot: inner }))).toBe(false);
  });

  test("a file inside a detected installation is a Roxen file", async () => {
    const home = join(tmp, "roxen6");
    const file = write("roxen6/server/base_server/helper.pike", "int f(){ return 1; }\n");
    expect(await isRoxenFile(file, null, ctx({ roxenHome: home }))).toBe(true);
  });

  test("a file outside the installation is not activated by it", async () => {
    const home = join(tmp, "roxen6");
    mkdirSync(home, { recursive: true });
    const file = write("other/plain.pike", "int f(){ return 1; }\n");
    expect(await isRoxenFile(file, null, ctx({ roxenHome: home }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mixed workspace
// ---------------------------------------------------------------------------

describe("mixed workspace", () => {
  test("activating one file does not activate an unrelated one", async () => {
    const roxenModule = write("roxen/mod.pike", "#include <module.h>\n");
    const plainProgram = write("app/main.pike", "int main(){ write(\"hi\\n\"); return 0; }\n");

    expect(await isRoxenFile(roxenModule, null, ctx())).toBe(true);
    expect(await isRoxenFile(plainProgram, null, ctx())).toBe(false);
    // Order must not matter — the memo is per-directory, not per-workspace.
    clearRoxenActivationCache();
    expect(await isRoxenFile(plainProgram, null, ctx())).toBe(false);
    expect(await isRoxenFile(roxenModule, null, ctx())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

describe("encoding", () => {
  test("finds a marker in an ISO-8859-1 file read from disk", async () => {
    // A Latin-1 copyright sign before the include: read as UTF-8 this file
    // decodes to replacement characters, but the marker is still on its own
    // line, so this also guards the weaker failure of losing the line.
    const full = join(tmp, "latin1.pike");
    writeFileSync(full, Buffer.from([
      ...Buffer.from("// Copyright "), 0xa9, ...Buffer.from(" Roxen\n#include <module.h>\n"),
    ]));
    expect(await isRoxenFile(full, null, ctx())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Corpus coverage
// ---------------------------------------------------------------------------

describe.skipIf(!roxenAvailable)("activation covers the real module tree", () => {
  test("every Pike file under server/modules/ is a Roxen file", async () => {
    const modulesDir = join(roxenHome!, "server", "modules");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".pike") || entry.name.endsWith(".pmod")) files.push(full);
      }
    };
    walk(modulesDir);

    // The measured corpus has 170 of these; a wildly different count means the
    // checkout is not what the numbers were taken against.
    expect(files.length).toBeGreaterThan(100);

    const activationCtx: RoxenActivationContext = {
      mode: "auto",
      roxenHome: null, // Deliberately null: markers plus directories must suffice.
      workspaceRoot: roxenHome!,
    };

    const missed: string[] = [];
    for (const file of files) {
      if (!(await isRoxenFile(file, null, activationCtx))) missed.push(file);
    }
    expect(missed, "these module files were not recognised as Roxen").toEqual([]);
  }, 60_000);
});
