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
