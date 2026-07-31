/**
 * Parse-tree lifetime tests.
 *
 * Regression for the hover crash recorded by the behavioural audit:
 *
 *   textDocument/hover  server/base_server/configuration.pike:563:26
 *   Request textDocument/hover failed with message:
 *   null is not an object (evaluating '(tree ? …).rootNode')
 *
 * `parse()` hands back a tree owned by the parser's LRU cache. The cache frees
 * trees on re-parse of the same URI, on LRU eviction, on didClose and on the
 * memory governor's sweep — and web-tree-sitter reports `rootNode === null` for
 * a freed tree. A handler that keeps the tree across an `await` can therefore
 * be left holding freed memory.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";
import {
  initParser,
  parse,
  deleteTree,
  clearTreeCache,
  withBorrowedTree,
} from "../../server/src/parser";
import type { WorkspaceIndex } from "../../server/src/features/workspaceIndex";

// ---------------------------------------------------------------------------
// Parser-level ownership
// ---------------------------------------------------------------------------

describe("parse tree ownership", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("a cached tree is freed by the next parse of the same URI", async () => {
    const uri = "file:///test/lifetime-freed.pike";
    const tree = parse("int a;\n", uri);
    expect(tree.rootNode).not.toBeNull();

    // What a concurrent didChange does: re-parse the same URI. The cache
    // replaces the entry and deletes the tree it was holding.
    parse("int a;\nint b;\n", uri);

    expect(tree.rootNode).toBeNull();
    deleteTree(uri);
  });

  test("a borrowed tree survives re-parse, eviction and didClose", async () => {
    const uri = "file:///test/lifetime-borrowed.pike";
    const source = "int aaa;\nint main() { return 0; }\n";

    await withBorrowedTree(parse(source, uri), async (borrowed) => {
      const before = borrowed.rootNode.descendantForPosition({ row: 1, column: 4 });
      expect(before?.text).toBe("main");

      // Every way the cache can free the tree it handed out, in one go.
      parse(source + "int later;\n", uri);
      deleteTree(uri);
      clearTreeCache();
      await Promise.resolve();

      const after = borrowed.rootNode.descendantForPosition({ row: 1, column: 4 });
      expect(after?.text).toBe("main");
      expect(borrowed.rootNode.descendantCount).toBe(before!.tree.rootNode.descendantCount);
    });
  });
});

// ---------------------------------------------------------------------------
// The hover path that crashed
// ---------------------------------------------------------------------------

describe("hover survives a concurrent re-parse", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.teardown();
  });

  test("dot access whose module lookup races a re-parse", async () => {
    const uri = "file:///test/hover-uaf.pike";
    const source = [
      "void test() {",
      "  Foo.bar();",
      "}",
    ].join("\n");
    server.openDoc(uri, source);

    // The hover handler parses once and reuses that tree after several awaits.
    // `resolveModule` is one of those awaits: it is reached from
    // resolveAccessCore when the LHS of a dot access names no declaration.
    // Freeing the tree there is exactly what a didChange landing mid-hover
    // does, and makes the race deterministic.
    const index = server.server.index as WorkspaceIndex;
    const original = index.resolveModule.bind(index);
    let raced = false;
    (index as unknown as { resolveModule: WorkspaceIndex["resolveModule"] }).resolveModule =
      async (path: string, fromUri: string) => {
        raced = true;
        parse(source + "\n// concurrent edit\n", uri);
        return original(path, fromUri);
      };

    try {
      // Cursor on `bar`.
      const result = await server.client.sendRequest("textDocument/hover", {
        textDocument: { uri },
        position: { line: 1, character: 7 },
      });
      expect(raced).toBe(true);
      expect(result === null || typeof result === "object").toBe(true);
    } finally {
      (index as unknown as { resolveModule: WorkspaceIndex["resolveModule"] }).resolveModule =
        original;
    }
  });
});
