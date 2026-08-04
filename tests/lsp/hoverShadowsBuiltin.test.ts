/**
 * Regression: a value the user declares shadows the Pike builtin of the same
 * name, and hover must describe the declaration.
 *
 * `hoverFromStdlib` looked the declaration's NAME up in the predef index and
 * answered with the efun. It already excluded `function` and `method` for
 * exactly this reason — a user's `int write(...)` shows its own signature — but
 * variables, parameters and constants were never added, so `int time = 5;`
 * hovered as "seconds since 00:00:00 UTC, 1 Jan 1970", `int fn(int max)`
 * hovered as the `max()` efun, and `int mv = 3;` as "Rename or move a file".
 * Wrong at the declaration and at every use.
 *
 * These names are not exotic: the audit found 34 real occurrences of `time`,
 * `hash`, `error`, `filter` and `version` as user variables across the corpus
 * and Roxen 6.1.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";

interface Hover { contents: { kind: string; value: string } }

// `time`, `max`, `mv`, `hash` and `filter` are all Pike builtins.
const SRC = `int time = 5;

int fn(int max) {
  int mv = 3;
  int hash = 9;
  return max + time + mv + hash;
}

int main() {
  write("%d\\n", fn(1));
  return 0;
}
`;

describe("a declared value shadows the builtin of the same name", () => {
  let server: TestServer;
  let root: string;
  let uri: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-hover-shadow-"));
    const file = join(root, "shadow.pike");
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

  async function hoverAt(line: number, character: number): Promise<string> {
    const h = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri }, position: { line, character },
    }) as Hover | null;
    return h?.contents?.value ?? "";
  }

  const declarations: Array<[string, number, number, string]> = [
    ["file-scope variable time", 0, 4, "int time = 5"],
    ["parameter max", 2, 11, "int max"],
    ["local mv", 3, 6, "int mv = 3"],
    ["local hash", 4, 6, "int hash = 9"],
  ];

  for (const [label, line, character, expected] of declarations) {
    test(`${label} hovers as itself, not the builtin`, async () => {
      const value = await hoverAt(line, character);
      expect(value, `${label} at ${line}:${character}`).toContain(expected);
    });
  }

  const uses: Array<[string, number, number, string]> = [
    ["use of max", 5, 9, "int max"],
    ["use of time", 5, 15, "int time = 5"],
    ["use of mv", 5, 22, "int mv = 3"],
  ];

  for (const [label, line, character, expected] of uses) {
    test(`${label} hovers as the declaration`, async () => {
      const value = await hoverAt(line, character);
      expect(value, `${label} at ${line}:${character}`).toContain(expected);
    });
  }

  test("a builtin the file does NOT declare still shows its documentation", async () => {
    // Guard the guard: if this regressed to "no builtin hover ever", the tests
    // above would pass for the wrong reason.
    const value = await hoverAt(9, 3); // `write` in main()
    expect(value).toContain("write(");
    expect(value.length, "the builtin must still carry its docs").toBeGreaterThan(30);
  });
});
