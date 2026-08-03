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
import { isRoxenFile } from "../../server/src/features/roxenActivation";
import { roxenAvailable, roxenHome } from "../helpers/roxenAvailable";
import { detectRoxenPaths } from "../../server/src/features/roxenDetection";

/**
 * The activation rule only asks WHETHER an installation was detected, never
 * reads it, so these cases need no Roxen on the machine — which is the state
 * most machines are in, and the one the feature exists for. Only the
 * end-to-end case below needs a real tree, and it skips without one.
 */
const SYNTHETIC_ROXEN_HOME = "/nonexistent/roxen";

interface Diagnostic { source?: string; message: string }

/** Open one file and return the diagnostics finally published for it. */
async function diagnosticsFor(
  name: string, src: string, pikeJson?: string,
): Promise<Diagnostic[]> {
  const root = mkdtempSync(join(tmpdir(), "pike-roxdiag-"));
  try {
    if (pikeJson) writeFileSync(join(root, "pike.json"), pikeJson);
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
 * a module being edited outside the install tree. `Roxen.pmod` does not compile
 * under Pike 8.0 at all, so those references can never resolve and every one
 * became an error about the environment.
 *
 * The evidence is weaker than a marker, so it counts only when an installation
 * was actually detected: with no Roxen on the machine, "Undefined identifier
 * Roxen." is the truth and must survive.
 */
describe("a file naming Roxen's runtime counts as Roxen — when Roxen exists", () => {
  const NAMES_ROXEN = `int main() {\n  string s = Roxen.html_encode_string("x");\n  return sizeof(s);\n}\n`;
  const PLAIN = `int main() {\n  return 0;\n}\n`;

  const cases: Array<[string, string, string | null, boolean]> = [
    ["names Roxen, installation present", NAMES_ROXEN, SYNTHETIC_ROXEN_HOME, true],
    ["names Roxen, no installation", NAMES_ROXEN, null, false],
    ["plain pike, installation present", PLAIN, SYNTHETIC_ROXEN_HOME, false],
  ];

  for (const [label, src, home, expected] of cases) {
    test(label, async () => {
      const active = await isRoxenFile("/tmp/proj/standalone.pike", src, {
        mode: "auto", roxenHome: home, workspaceRoot: "/tmp/proj",
      });
      expect(active).toBe(expected);
    });
  }

  test("a marker header still wins with no installation", async () => {
    const active = await isRoxenFile("/tmp/proj/m.pike",
      `#include <module.h>\n${PLAIN}`,
      { mode: "auto", roxenHome: null, workspaceRoot: "/tmp/proj" });
    expect(active).toBe(true);
  });

  // Needs a genuine installation for detection to accept the pike.json path,
  // so it skips where there is none rather than failing.
  test.skipIf(!roxenAvailable)(
    "end to end: a configured Roxen silences it",
    async () => {
      const withRoxen = await diagnosticsFor(
        "standalone.pike", NAMES_ROXEN,
        JSON.stringify({ roxen: { path: roxenHome } }),
      );
      expect(withRoxen.filter(d => d.source === "pike").map(d => d.message)).toEqual([]);
    },
    40000,
  );

  test("end to end: with no Roxen detected the error is the truth and stays", async () => {
    // Detection also discovers installations under /usr/local — which is where
    // the Docker lab puts one — so "no pike.json" does not imply "no Roxen".
    // Ask, rather than assume: with an installation present this case cannot be
    // staged, and asserting it anyway would fail inside the lab.
    const detected = await detectRoxenPaths(tmpdir());
    if (detected.paths) return;

    const without = await diagnosticsFor("standalone.pike", NAMES_ROXEN);
    expect(without.some(
      d => d.source === "pike" && /Undefined identifier Roxen/.test(d.message),
    )).toBe(true);
  }, 40000);
});
