/**
 * Go-to-definition must not lose a cross-file answer it already found.
 *
 * `resolveCrossFileDefinition` indexes an inherit target on demand, then
 * checks whether the index generation moved and retries if it did — a guard
 * against returning a result computed against a table that has since changed.
 *
 * But the generation moves *because of that very indexing*: upserting the
 * target invalidates its dependents, which includes the file being resolved
 * from. On a cold index the retry then finds that file's symbol table gone,
 * returns null, and the correct answer already in hand is thrown away.
 *
 * The symptom was a go-to-definition that returned null on a cold cache and
 * the right location once the cache was warm — read as flakiness for a while,
 * and it distorted every audit sweep that measured navigation.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestServer, type TestServer } from "./helpers";

interface LocationResult {
  uri: string;
  range: { start: { line: number; character: number } };
}

let server: TestServer;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "pike-cold-index-"));
  mkdirSync(root, { recursive: true });

  // The target is never opened, so it is absent from the index until the
  // definition request indexes it on demand — which is the whole point.
  writeFileSync(join(root, "base.pike"), "int base_helper(int n) { return n; }\n", "utf8");
  writeFileSync(
    join(root, "leaf.pike"),
    'inherit "base.pike";\n\nint use() { return base_helper(1); }\n',
    "utf8",
  );

  server = await createTestServer({ rootUri: pathToFileURL(root).href });
});

afterAll(async () => {
  await server.teardown();
});

describe("cross-file definition on a cold index", () => {
  test("resolves an inherited symbol the first time it is asked", async () => {
    const leafUri = pathToFileURL(join(root, "leaf.pike")).href;
    server.openDoc(leafUri, 'inherit "base.pike";\n\nint use() { return base_helper(1); }\n');

    // `base_helper` at line 2. First ask, cold index — this is the one that
    // used to come back null.
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri: leafUri },
      position: { line: 2, character: 22 },
    }) as LocationResult | null;

    expect(result).not.toBeNull();
    expect(result!.uri.endsWith("base.pike")).toBe(true);
    expect(result!.range.start.line).toBe(0);
  });
});
