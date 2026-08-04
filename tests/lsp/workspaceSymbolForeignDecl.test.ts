/**
 * Regression: workspace/symbol must locate a symbol in the file that declares
 * it, not in every file that #includes it.
 *
 * A symbol table holds declarations cloned from the files it includes and
 * inherits, carrying the coordinates they have in THEIR file (the project's
 * standing rule). `collectMatchingSymbols` paired every declaration with the
 * including entry's URI, so a header's symbol was reported at the header's
 * line and column inside the includer — a random line, and past the end of the
 * file whenever the includer is shorter than the header.
 *
 * The invariant asserted here needs no oracle: whatever location a symbol
 * search returns, the text at that location must be the symbol's name.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface SymbolInformation { name: string; location: { uri: string; range: Range } }

// The declaration sits far down the header, past the end of the short includer.
const HEADER_SRC = `// 1\n// 2\n// 3\n// 4\n// 5\n// 6\n// 7\n// 8\nint uniquely_named_helper() { return 7; }\n`;
const APP_SRC = `#include "big.h"\nint main() { return uniquely_named_helper(); }\n`;

describe("workspace/symbol locates symbols in their declaring file", () => {
  let server: TestServer;
  let root: string;
  let uri: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-wsym-foreign-"));
    writeFileSync(join(root, "big.h"), HEADER_SRC);
    const app = join(root, "app.pike");
    writeFileSync(app, APP_SRC);
    uri = pathToFileURL(app).href;
    server = await createTestServer({ rootUri: pathToFileURL(root).href });
    server.openDoc(uri, APP_SRC);
    await waitForFileEntry(server, [uri], 30000);
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("every returned location actually holds the symbol's name", async () => {
    const results = await server.client.sendRequest("workspace/symbol", {
      query: "uniquely_named_helper",
    }) as SymbolInformation[] | null;

    expect(results, "the symbol must be findable at all").not.toBeNull();
    expect(results!.length).toBeGreaterThan(0);

    for (const sym of results!) {
      const lines = readFileSync(fileURLToPath(sym.location.uri), "utf8").split("\n");
      const line = lines[sym.location.range.start.line];
      expect(line, `${sym.location.uri}:${sym.location.range.start.line} is past the end of the file`)
        .toBeDefined();
      const text = line.slice(
        sym.location.range.start.character,
        sym.location.range.start.character + sym.name.length,
      );
      expect(text, `location must hold ${sym.name}, found ${JSON.stringify(line)}`).toBe(sym.name);
    }
  });

  test("the symbol is not reported once per includer", async () => {
    const results = await server.client.sendRequest("workspace/symbol", {
      query: "uniquely_named_helper",
    }) as SymbolInformation[] | null;

    const keys = new Set(
      (results ?? []).map(s => `${s.location.uri}:${s.location.range.start.line}`),
    );
    expect(keys.size, "one declaration, one result").toBe(1);
  });
});
