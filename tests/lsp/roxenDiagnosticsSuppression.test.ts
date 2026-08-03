/**
 * Regression: a Roxen file must not be reported against the stock pike binary.
 *
 * Roxen's runtime — `Roxen`, `RXML`, `Variable`, `inherit "module"` — exists
 * only inside a running Roxen server, and Roxen 6.1 does not run on Pike 8.0 at
 * all. Compiling one of its modules with the plain binary therefore produces
 * errors about the environment, not the code: server/modules/tags/xml-db-mirror.pike
 * yielded 75 of them, led by "Undefined identifier Roxen.".
 *
 * The server already knew these files — hover and completion read roxenActive —
 * but the diagnostic path never asked.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer } from "./helpers";
import { isRoxenFile, namesRoxenRuntime } from "../../server/src/features/roxenActivation";




interface Diagnostic { source?: string; message: string }

/** Open one file and return the diagnostics finally published for it. */
async function diagnosticsFor(name: string, src: string): Promise<Diagnostic[]> {
  const root = mkdtempSync(join(tmpdir(), "pike-roxdiag-"));
  try {
    const file = join(root, name);
    writeFileSync(file, src);
    const uri = pathToFileURL(file).href;
    const server = await createTestServer({ rootUri: pathToFileURL(root).href });
    const published: Diagnostic[][] = [];
    server.client.onNotification(
      "textDocument/publishDiagnostics",
      (p: { uri: string; diagnostics: Diagnostic[] }) => {
        if (p.uri === uri) published.push(p.diagnostics);
      },
    );
    server.openDoc(uri, src);
    await new Promise(r => setTimeout(r, 6000));
    await server.teardown();
    return published[published.length - 1] ?? [];
  } finally {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const ROXEN_SRC = `#include <module.h>
int main() {
  string s = Roxen.html_encode_string("x");
  RXML.Frame f;
  return sizeof(s) + sizeof((array) f);
}
`;

describe("Roxen files are not compiled by the stock pike binary", () => {
  test("no pike-compiler diagnostics for a Roxen file", async () => {
    const diags = await diagnosticsFor("roxmod.pike", ROXEN_SRC);
    const fromPike = diags.filter(d => d.source === "pike");
    expect(fromPike.map(d => d.message)).toEqual([]);
  }, 30000);

  test("a plain Pike file still gets them", async () => {
    const diags = await diagnosticsFor(
      "plain.pike", `int main() {\n  int x = "not an int";\n  return x;\n}\n`,
    );
    expect(diags.some(d => d.source === "pike"),
      "the stock compiler must still report a real type error").toBe(true);
  }, 30000);

  test("a real syntax error in a Roxen file is still reported", async () => {
    const diags = await diagnosticsFor(
      "roxbad.pike", `#include <module.h>\nint main() {\n  int x = ;\n  return 0\n}\n`,
    );
    // Parse diagnostics do not need the compiler, and must survive the gate.
    expect(diags.some(d => /parse error/i.test(d.message)),
      "syntax errors must still surface").toBe(true);
  }, 30000);
});

// ---------------------------------------------------------------------------
// Which files count as Roxen
// ---------------------------------------------------------------------------

/**
 * A file can name Roxen's runtime without carrying any of the marker headers —
 * a module edited outside the install tree. `Roxen.pmod` does not compile under
 * Pike 8.0 at all, so those references can never resolve and every one became
 * an error about the environment.
 *
 * This is deliberately NOT an activation marker. Naming `Roxen.foo` does not
 * make a file a Roxen module, and Roxen hover and completion must not leak into
 * a plain Pike file that merely mentions it — roxenEndToEnd.test.ts holds that
 * line. It is only enough to know the stock compiler cannot check the file.
 *
 * And it depends on nothing machine-specific: no installation, no `pike.json`
 * (which carries no `roxen` key by convention), no `/usr/local/roxen*`. A rule
 * needing any of those would do nothing on the machines that hit this.
 */
describe("naming Roxen's runtime is enough to skip the pike compile", () => {
  const NAMES_ROXEN = `int main() {\n  string s = Roxen.html_encode_string("x");\n  return sizeof(s);\n}\n`;
  const NAMES_RXML = `int main() {\n  RXML.Frame f;\n  return 0;\n}\n`;
  const PLAIN = `int main() {\n  return 0;\n}\n`;

  test("recognises Roxen. and RXML., and nothing else", () => {
    expect(namesRoxenRuntime(NAMES_ROXEN)).toBe(true);
    expect(namesRoxenRuntime(NAMES_RXML)).toBe(true);
    expect(namesRoxenRuntime(PLAIN)).toBe(false);
    // A local named `roxen` is an ordinary Pike variable, not the module.
    expect(namesRoxenRuntime(`int f(object roxen) { return roxen->x; }\n`)).toBe(false);
    // Not a substring of a longer identifier.
    expect(namesRoxenRuntime(`int f() { return MyRoxen.thing; }\n`)).toBe(false);
  });

  test("it does NOT activate Roxen mode — hover and completion stay out", async () => {
    // roxenHome null and no marker: the file mentions Roxen, it is not one.
    const active = await isRoxenFile("/tmp/proj/plain.pike", NAMES_ROXEN, {
      mode: "auto", roxenHome: null, workspaceRoot: "/tmp/proj",
    });
    expect(active).toBe(false);
  });

  test("end to end: no installation, no config, no compiler noise", async () => {
    const diags = await diagnosticsFor("standalone.pike", NAMES_ROXEN);
    expect(diags.filter(d => d.source === "pike").map(d => d.message)).toEqual([]);
  }, 40000);

  test("end to end: the same holds for RXML.", async () => {
    const diags = await diagnosticsFor("standalone.pike", NAMES_RXML);
    expect(diags.filter(d => d.source === "pike").map(d => d.message)).toEqual([]);
  }, 40000);
});
