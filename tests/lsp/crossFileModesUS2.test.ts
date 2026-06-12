/**
 * T046: Cross-file definition over indexing modes (US2).
 *
 * Goal: cross-file definition must resolve when the target is in a file indexed
 * by background indexing (full mode) or on-demand dependency closure
 * (openFiles mode).
 *
 * RED state: the lazy global preparation and dependency-map routing (T054-T060)
 * is not yet wired, so cross-file definition may not resolve when the target
 * file was indexed by the background indexer rather than opened directly.
 *
 * Uses one server per file (beforeAll/afterAll) because teardown() terminates
 * the in-process server — multiple teardowns within a single file would kill
 * the test runner.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestServer, type TestServer } from "./helpers";

const BASE_SRC = [
  "class Base {",
  "  int value;",
  "  int get_value() { return value; }",
  "}",
  "",
  "int main() { return 0; }",
].join("\n");

const CHILD_SRC = [
  'inherit "base.pike";',
  "",
  "class Child {",
  "  void use() {",
  "    Base b = Base();",
  "    return b->get_value();",
  "  }",
  "}",
  "",
  "int run() { return 0; }",
].join("\n");

describe("T046: full mode — cross-file definition via background indexing (US2)", () => {
  let ws: TestServer;
  let childUri: string;
  let baseUri: string;

  beforeAll(async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pike-t046-"));
    writeFileSync(join(tempDir, "base.pike"), BASE_SRC);
    writeFileSync(join(tempDir, "child.pike"), CHILD_SRC);
    baseUri = pathToFileURL(join(tempDir, "base.pike")).href;
    childUri = pathToFileURL(join(tempDir, "child.pike")).href;

    ws = await createTestServer({
      rootUri: pathToFileURL(tempDir).href,
      initializationOptions: {
        pike: {
          languageServer: {
            indexingMode: "full",
            backgroundIndexEnabled: true,
          },
        },
      },
    });

    ws.openDoc(childUri, CHILD_SRC);
    // Allow background indexing to complete.
    await new Promise(resolve => setTimeout(resolve, 300));
  });

  afterAll(async () => {
    await ws.teardown();
  });

  test("definition of Base reference resolves to base.pike", async () => {
    // Line 4: "    Base b = Base();" — "Base" at character 4 (0-indexed)
    const result = await ws.client.sendRequest("textDocument/definition", {
      textDocument: { uri: childUri },
      position: { line: 4, character: 4 },
    }) as { uri?: string } | null;

    expect(result).not.toBeNull();
    expect(result!.uri).toBe(baseUri);
  });

  test("definition of get_value method resolves to base.pike", async () => {
    // Line 5: "    return b->get_value();" — "get_value" at character 14
    const result = await ws.client.sendRequest("textDocument/definition", {
      textDocument: { uri: childUri },
      position: { line: 5, character: 14 },
    }) as { uri?: string } | null;

    expect(result).not.toBeNull();
    expect(result!.uri).toBe(baseUri);
  });
});
