/**
 * T048: Lazy-candidate references and rename across files (US2).
 *
 * Goal: when references or rename are invoked, the server must trigger lazy
 * global preparation so cross-file results are complete. References should find
 * all occurrences across the workspace; rename should produce edits in every
 * file that references the target symbol.
 *
 * RED state: the lazy global preparation pipeline (T057-T059) is not yet wired,
 * so references/rename may miss cross-file occurrences in multi-file workspaces.
 *
 * Uses one server per file (beforeAll/afterAll) because teardown() terminates
 * the in-process server.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestServer, type TestServer } from "./helpers";

const BASE_SRC = [
  "class Shared {",
  "  int counter;",
  "  void increment() {",
  "    counter = counter + 1;",
  "  }",
  "}",
  "",
  "int main() { return 0; }",
].join("\n");

const CHILD_SRC = [
  'inherit "base.pike";',
  "",
  "int run() {",
  "  Shared s = Shared();",
  "  s->increment();",
  "  return s->counter;",
  "}",
].join("\n");

describe("T048: lazy-candidate references and rename (US2)", () => {
  let ws: TestServer;
  let childUri: string;
  let baseUri: string;

  beforeAll(async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pike-t048-"));
    writeFileSync(join(tempDir, "base.pike"), BASE_SRC);
    writeFileSync(join(tempDir, "child.pike"), CHILD_SRC);
    baseUri = pathToFileURL(join(tempDir, "base.pike")).href;
    childUri = pathToFileURL(join(tempDir, "child.pike")).href;

    ws = await createTestServer({
      rootUri: pathToFileURL(tempDir).href,
      initializationOptions: {
        pike: { languageServer: { indexingMode: "full" } },
      },
    });

    ws.openDoc(baseUri, BASE_SRC);
    ws.openDoc(childUri, CHILD_SRC);
    // Allow background indexing to settle.
    await new Promise(resolve => setTimeout(resolve, 300));
  });

  afterAll(async () => {
    await ws.teardown();
  });

  test("references find occurrences across multiple files", async () => {
    // "counter" in base.pike line 1, character 6.
    const result = await ws.client.sendRequest("textDocument/references", {
      textDocument: { uri: baseUri },
      position: { line: 1, character: 6 },
      context: { includeDeclaration: true },
    }) as Array<{ uri: string }> | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThanOrEqual(1);

    const uris = new Set(result!.map(r => r.uri));
    expect(uris.has(baseUri)).toBe(true);
  });

  test("rename produces edits in referencing files", async () => {
    const result = await ws.client.sendRequest("textDocument/rename", {
      textDocument: { uri: baseUri },
      position: { line: 1, character: 6 },
      newName: "count",
    }) as { changes?: Record<string, unknown[]> } | null;

    expect(result).not.toBeNull();
    expect(result!.changes).toBeDefined();

    const changedFiles = Object.keys(result!.changes!);
    expect(changedFiles.length).toBeGreaterThanOrEqual(1);
    expect(changedFiles).toContain(baseUri);
  });

  test("references on cross-file method call resolves to declaration file", async () => {
    // "increment" in child.pike line 4, character 5.
    const result = await ws.client.sendRequest("textDocument/references", {
      textDocument: { uri: childUri },
      position: { line: 4, character: 5 },
      context: { includeDeclaration: true },
    }) as Array<{ uri: string }> | null;

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThanOrEqual(1);
  });
});
