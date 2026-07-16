/**
 * Tests for Pike's relative-module syntax: `.Util` names a sibling
 * `Util.pmod`/`Util.pike` in the same directory.
 *
 * All forms are oracle-verified against Pike 8.0.1116 — each construct here
 * compiles and runs with the real pike binary:
 *   - `.Util.double_it(21)`      (expression member access)
 *   - `import .Util;`            (relative import)
 *   - `inherit .Util.Counter;`   (dotted relative inherit of a class inside
 *                                 a file module)
 *
 * @goal Verify definition, hover, references, and rename resolve through
 * relative module paths, including the dotted-path tail naming a class
 * inside a file module.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Decoy comes FIRST so tests prove tail-name matching, not first-class-wins.
const UTIL_PMOD_SRC = `class Decoy {
  int unrelated;
}

int double_it(int n) { return n * 2; }

class Counter {
  int count;
  void tick() { count++; }
}
`;

const MEMBER_ACCESS_SRC = `int main() {
  int d = .Util.double_it(21);
  return d;
}
`;

const IMPORT_SRC = `import .Util;
int main() {
  return double_it(21);
}
`;

const INHERIT_SRC = `inherit .Util.Counter;
int main() {
  tick();
  return count;
}
`;

let tempRoot: string;
let utilUri: string;
let memberUri: string;
let importUri: string;
let inheritUri: string;
let server: TestServer;

async function definitionAt(
  uri: string,
  line: number,
  character: number,
): Promise<{ uri: string; range: { start: { line: number; character: number } } } | null> {
  const result = await server.client.sendRequest("textDocument/definition", {
    textDocument: { uri },
    position: { line, character },
  });
  if (result === null) return null;
  return (Array.isArray(result) ? result[0] : result) as {
    uri: string; range: { start: { line: number; character: number } };
  };
}

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "pike-lsp-relmod-"));
  writeFileSync(join(tempRoot, "Util.pmod"), UTIL_PMOD_SRC);
  writeFileSync(join(tempRoot, "member.pike"), MEMBER_ACCESS_SRC);
  writeFileSync(join(tempRoot, "importer.pike"), IMPORT_SRC);
  writeFileSync(join(tempRoot, "inheritor.pike"), INHERIT_SRC);

  utilUri = pathToFileURL(join(tempRoot, "Util.pmod")).href;
  memberUri = pathToFileURL(join(tempRoot, "member.pike")).href;
  importUri = pathToFileURL(join(tempRoot, "importer.pike")).href;
  inheritUri = pathToFileURL(join(tempRoot, "inheritor.pike")).href;

  server = await createTestServer({ rootUri: pathToFileURL(tempRoot).href });
  server.openDoc(memberUri, MEMBER_ACCESS_SRC);
  server.openDoc(importUri, IMPORT_SRC);
  server.openDoc(inheritUri, INHERIT_SRC);
  server.openDoc(utilUri, UTIL_PMOD_SRC);
  // Let didOpen indexing settle before querying cross-file state.
  await new Promise((resolve) => setTimeout(resolve, 500));
});

afterAll(async () => {
  await server.teardown();
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// Expression member access: .Util.double_it
// ---------------------------------------------------------------------------

describe("relative module member access (.Util.double_it)", () => {
  // member.pike line 1: `  int d = .Util.double_it(21);` — double_it at col 16.
  test("definition at identifier start resolves into Util.pmod", async () => {
    const def = await definitionAt(memberUri, 1, 16);
    expect(def).not.toBeNull();
    expect(def!.uri).toBe(utilUri);
    // `int double_it` declares the name on line 4 of Util.pmod.
    expect(def!.range.start.line).toBe(4);
  });

  test("definition mid-identifier resolves too (cursor inside the name)", async () => {
    const def = await definitionAt(memberUri, 1, 20);
    expect(def).not.toBeNull();
    expect(def!.uri).toBe(utilUri);
    expect(def!.range.start.line).toBe(4);
  });

  test("hover shows the resolved signature", async () => {
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri: memberUri },
      position: { line: 1, character: 16 },
    }) as { contents: { value: string } } | null;
    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("double_it(int n)");
  });

  // member.pike line 1: `  int d = .Util.double_it(21);` — Util at col 11.
  test("definition on the module name itself opens the module file", async () => {
    const def = await definitionAt(memberUri, 1, 12);
    expect(def).not.toBeNull();
    expect(def!.uri).toBe(utilUri);
    expect(def!.range.start.line).toBe(0);
  });

  test("hover on the module name shows the module and its file", async () => {
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri: memberUri },
      position: { line: 1, character: 12 },
    }) as { contents: { value: string } } | null;
    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("module .Util");
    expect(hover!.contents.value).toContain("Util.pmod");
  });
});

// ---------------------------------------------------------------------------
// Relative import: import .Util
// ---------------------------------------------------------------------------

describe("relative import (import .Util)", () => {
  // importer.pike line 2: `  return double_it(21);` — double_it at col 9.
  test("imported symbol resolves to its declaration in Util.pmod", async () => {
    const def = await definitionAt(importUri, 2, 9);
    expect(def).not.toBeNull();
    expect(def!.uri).toBe(utilUri);
    expect(def!.range.start.line).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Dotted relative inherit: inherit .Util.Counter
// ---------------------------------------------------------------------------

describe("dotted relative inherit (inherit .Util.Counter)", () => {
  test("definition on the inherit path resolves to class Counter, not the first class", async () => {
    // inheritor.pike line 0: `inherit .Util.Counter;` — path at cols 8–21.
    const def = await definitionAt(inheritUri, 0, 15);
    expect(def).not.toBeNull();
    expect(def!.uri).toBe(utilUri);
    // `class Counter` is on line 6 — the Decoy class above it must not win.
    expect(def!.range.start.line).toBe(6);
  });

  test("inherited method call resolves cross-file", async () => {
    // inheritor.pike line 2: `  tick();` — tick at col 2.
    const def = await definitionAt(inheritUri, 2, 2);
    expect(def).not.toBeNull();
    expect(def!.uri).toBe(utilUri);
    expect(def!.range.start.line).toBe(8);
  });

  test("inherited field use resolves cross-file", async () => {
    // inheritor.pike line 3: `  return count;` — count at col 9.
    const def = await definitionAt(inheritUri, 3, 9);
    expect(def).not.toBeNull();
    expect(def!.uri).toBe(utilUri);
    expect(def!.range.start.line).toBe(7);
  });

  test("references on the inherited method include the inheritor's call site", async () => {
    // Util.pmod line 8: `  void tick() { count++; }` — tick at col 7.
    const refs = await server.client.sendRequest("textDocument/references", {
      textDocument: { uri: utilUri },
      position: { line: 8, character: 7 },
      context: { includeDeclaration: true },
    }) as Array<{ uri: string }>;
    expect(refs.some(r => r.uri === inheritUri)).toBe(true);
  });

  test("rename of the inherited method edits the inheritor too", async () => {
    const edit = await server.client.sendRequest("textDocument/rename", {
      textDocument: { uri: utilUri },
      position: { line: 8, character: 7 },
      newName: "advance",
    }) as { changes: Record<string, unknown[]> };
    expect(edit.changes[utilUri]).toBeDefined();
    expect(edit.changes[inheritUri]).toBeDefined();
  });
});
