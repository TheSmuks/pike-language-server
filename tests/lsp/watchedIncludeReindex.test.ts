/**
 * Regression: a watched-file change on an #include'd file must not drop it.
 *
 * `handleFileCreatedOrChanged` removed the changed file from the index and left
 * it out, on the stated assumption that "the on-demand indexer will re-index it
 * when cross-file queries need it". That holds for `inherit`, whose resolver
 * awaits indexOnDemand. It does not hold for `#include`: the merge in
 * includeWiring is synchronous and silently skips a target with no symbol
 * table.
 *
 * So one save of a header removed every symbol it provides from every file that
 * includes it — permanently. Definition, hover and completion for those symbols
 * stayed dead for the rest of the session, and editing the includer afterwards
 * did not bring them back. The content did not even have to change: a Changed
 * event with byte-identical content did it.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface Location { uri: string; range: Range }

const DEFS_SRC = `int helper_a(int x) { return x + 1; }\nint helper_b(int x) { return x + 2; }\n`;
const MAIN_SRC = `#include "defs.pike"\n\nint main() {\n  return helper_a(1);\n}\n`;

describe("a watched change on an included file keeps it resolvable", () => {
  let server: TestServer;
  let root: string;
  let mainUri: string;
  let defsUri: string;
  let defsPath: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-watch-include-"));
    defsPath = join(root, "defs.pike");
    writeFileSync(defsPath, DEFS_SRC);
    const main = join(root, "main.pike");
    writeFileSync(main, MAIN_SRC);
    mainUri = pathToFileURL(main).href;
    defsUri = pathToFileURL(defsPath).href;
    server = await createTestServer({ rootUri: pathToFileURL(root).href });
    server.openDoc(mainUri, MAIN_SRC);
    await waitForFileEntry(server, [mainUri], 30000);
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  /** Go to definition on `helper_a` in main.pike's call. */
  async function defineHelperA(): Promise<Location | null> {
    const res = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri: mainUri }, position: { line: 3, character: 12 },
    }) as Location | Location[] | null;
    return Array.isArray(res) ? res[0] ?? null : res;
  }

  test("resolves into the included file before any watch event", async () => {
    const before = await defineHelperA();
    expect(before, "guard the guard: it must resolve to begin with").not.toBeNull();
    expect(before!.uri).toBe(defsUri);
  });

  test("still resolves after a watched Changed event on the include", async () => {
    // Same bytes: the defect did not need the content to differ.
    writeFileSync(defsPath, DEFS_SRC);
    await server.client.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: defsUri, type: 2 /* Changed */ }],
    });
    // The handler re-indexes before refreshing dependents; give it a turn.
    await new Promise(resolve => setTimeout(resolve, 1500));

    const after = await defineHelperA();
    expect(after, "definition must survive a save of the header").not.toBeNull();
    expect(after!.uri).toBe(defsUri);
  });

  test("picks up a declaration that MOVED in the include", async () => {
    const moved = `// a new leading line\n// and another\n${DEFS_SRC}`;
    writeFileSync(defsPath, moved);
    await server.client.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: defsUri, type: 2 /* Changed */ }],
    });
    await new Promise(resolve => setTimeout(resolve, 1500));

    const after = await defineHelperA();
    expect(after, "definition must still resolve").not.toBeNull();
    expect(after!.uri).toBe(defsUri);
    // helper_a moved down by the two comment lines that were prepended.
    expect(after!.range.start.line, "must point at the NEW line, not the old one").toBe(2);
  });
});
