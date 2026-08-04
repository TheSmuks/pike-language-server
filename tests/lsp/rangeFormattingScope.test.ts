/**
 * Regression: rangeFormatting must not edit outside the requested range.
 *
 * The handler discarded `params.range`, formatted the whole document and
 * returned a single edit spanning it. VSCode routes both Format Selection and
 * format-on-paste through this request, so pasting one line into a legacy Pike
 * file silently reformatted every line of it.
 *
 * The formatter still runs over the whole text — indentation depends on
 * enclosing context — but only the requested lines are written back.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface TextEdit { range: Range; newText: string }

// Every declaration is mis-indented, so a whole-file format would touch them all.
const SRC = `int main() {
      int a   =   1;
      int b   =   2;
      int c   =   3;
  return a + b + c;
}
`;

describe("rangeFormatting stays inside the requested range", () => {
  let server: TestServer;
  let root: string;
  let uri: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-rangefmt-"));
    const file = join(root, "fmt.pike");
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

  async function formatLine(line: number): Promise<TextEdit[]> {
    return (await server.client.sendRequest("textDocument/rangeFormatting", {
      textDocument: { uri },
      range: { start: { line, character: 0 }, end: { line, character: 20 } },
      options: { tabSize: 2, insertSpaces: true },
    }) as TextEdit[] | null) ?? [];
  }

  test("every returned edit is inside the requested range", async () => {
    const edits = await formatLine(3);
    expect(edits.length, "guard the guard: line 3 is mis-indented, so there IS work")
      .toBeGreaterThan(0);
    for (const e of edits) {
      expect(e.range.start.line, `edit starts at line ${e.range.start.line}`).toBeGreaterThanOrEqual(3);
      expect(e.range.end.line, `edit ends at line ${e.range.end.line}`).toBeLessThanOrEqual(3);
    }
  });

  test("the edit rewrites only the requested line", async () => {
    const edits = await formatLine(3);
    const applied = SRC.split("\n");
    for (const e of edits) {
      applied[e.range.start.line] =
        applied[e.range.start.line].slice(0, e.range.start.character) +
        e.newText +
        applied[e.range.end.line].slice(e.range.end.character);
    }
    // Line 3 tidied…
    expect(applied[3]).toBe("  int c = 3;");
    // …and its neighbours left exactly as they were.
    expect(applied[1]).toBe("      int a   =   1;");
    expect(applied[2]).toBe("      int b   =   2;");
  });

  test("formatting an already-tidy line produces no edit", async () => {
    // Line 5 is `}` — nothing to do.
    const edits = await formatLine(5);
    expect(edits).toEqual([]);
  });
});
