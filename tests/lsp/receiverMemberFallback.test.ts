/**
 * Regression: `receiver->name` must not fall back to the global efun of that
 * name.
 *
 * The bare-name tiers below the receiver-aware ones cannot see the receiver, so
 * `b->write("x")` on a class with no `write` was answered with Pike's `write`
 * efun and documented "Writes a string on stdout"; `b->sizeof()` with the
 * `sizeof` efun. Both describe a completely different function from the one the
 * expression names — and neither member exists at all.
 *
 * The existing guard only covered receivers whose type has NO members
 * (mapping, string, int…). A class that is perfectly well known but simply
 * lacks the member fell straight through it.
 *
 * Deliberately narrow: the suppression applies when the receiver's class is
 * declared in the same file, so the member list is complete. "Cannot tell" must
 * never become "no member" — the controls below hold that line.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";

interface Hover { contents: { value: string } }

const SRC = `class Box {
  int w;
  int area() { return w; }
}

class Wide {
  inherit Box;
  int h;
}

int main() {
  Box b = Box();
  Wide g = Wide();
  int q = b->w;
  int r = b->area();
  int s = g->area();
  b->write("nope");
  b->sizeof();
  write("%d\\n", q + r + s);
  return 0;
}
`;

describe("member access does not fall back to a same-named efun", () => {
  let server: TestServer;
  let root: string;
  let uri: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-recv-"));
    const file = join(root, "recv.pike");
    writeFileSync(file, SRC);
    uri = pathToFileURL(file).href;
    server = await createTestServer({ rootUri: pathToFileURL(root).href });
    server.openDoc(uri, SRC);
    await waitForFileEntry(server, [uri], 30000);
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function hoverOn(line: number, needle: string): Promise<string | null> {
    const text = SRC.split("\n")[line];
    const character = text.indexOf(needle);
    expect(character, `${needle} present on line ${line}`).toBeGreaterThanOrEqual(0);
    const h = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri }, position: { line, character },
    }) as Hover | null;
    return h?.contents?.value ?? null;
  }

  test("a member the class does not have is not answered with the efun", async () => {
    const value = await hoverOn(16, "write");
    expect(value, "b->write must not be documented as the stdout efun").toBeNull();
  });

  test("sizeof on a class without it is not answered with the efun", async () => {
    const value = await hoverOn(17, "sizeof");
    expect(value, "b->sizeof must not be documented as the sizeof efun").toBeNull();
  });

  test("a real member still hovers", async () => {
    expect(await hoverOn(13, "w;") ?? "", "b->w").toContain("int w");
  });

  test("a real method still hovers", async () => {
    expect(await hoverOn(14, "area") ?? "", "b->area").toContain("area");
  });

  test("an INHERITED member still hovers", async () => {
    // Guard the guard: suppressing must not deny members that arrive by
    // inheritance rather than being declared in the class body.
    expect(await hoverOn(15, "area") ?? "", "g->area comes from Box").toContain("area");
  });

  test("a genuine efun call is still documented", async () => {
    const value = await hoverOn(18, "write") ?? "";
    expect(value, "the bare write() efun must keep its docs").toContain("write(");
  });
});
