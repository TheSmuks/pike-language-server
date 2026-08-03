/**
 * Regression: parameter inlay hints labelled a call with a DIFFERENT function's
 * parameter names.
 *
 * The callee was picked by name alone — the first matching reference anywhere
 * in the file, then any same-named declaration — so the hints contradicted
 * go-to-definition on the very same token. A call is bound by where it is
 * written.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";

interface Hint { position: { line: number; character: number }; label: string | unknown }

// A same-named function declared FIRST, with different parameter names.
const SRC = `mixed query(mixed args) { return args; }

class Wrapper {
  mixed query(string statement, mixed binding) { return 0; }
  mixed run() {
    return query("SELECT 1", 7);
  }
}
`;

describe("inlay hints name the function actually being called", () => {
  let server: TestServer;
  let root: string;
  let uri: string;
  const lines = SRC.split("\n");

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-inlay-"));
    const file = join(root, "i.pike");
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

  test("the call inside the class uses the class method's parameter names", async () => {
    const hints = await server.client.sendRequest("textDocument/inlayHint", {
      textDocument: { uri },
      range: { start: { line: 0, character: 0 }, end: { line: lines.length, character: 0 } },
    }) as Hint[];

    const callLine = lines.findIndex(l => l.includes('query("SELECT 1"'));
    const onCall = (hints ?? [])
      .filter(h => h.position.line === callLine)
      .map(h => (typeof h.label === "string" ? h.label : JSON.stringify(h.label)))
      .join(" ");

    expect(onCall).toContain("statement");
    // `args` is the file-scope query's only parameter — the wrong function.
    expect(onCall).not.toContain("args");
  });

  test("hints agree with go-to-definition on the same token", async () => {
    const callLine = lines.findIndex(l => l.includes('query("SELECT 1"'));
    const col = lines[callLine].indexOf("query");
    const def = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri }, position: { line: callLine, character: col + 2 },
    }) as { range: { start: { line: number } } } | Array<{ range: { start: { line: number } } }> | null;
    const first = Array.isArray(def) ? def[0] : def;
    expect(first).not.toBeNull();
    // Both must point at the class method, not the file-scope function.
    expect(lines[first!.range.start.line]).toContain("string statement");
  });
});
