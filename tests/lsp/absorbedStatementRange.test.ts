/**
 * Regression: an unfinished statement must not inflate the declaration's range.
 *
 * When a statement is missing its `;`, tree-sitter opens an ERROR node rather
 * than inserting one, and the declaration absorbs the following statement —
 * `int x = 1` with `int y = 2;` under it produces a local_declaration spanning
 * both lines. That range is what inlay hints, code lenses, the outline and the
 * enclosing-function lookup all read, so every one of them lands a line away
 * from what it annotates, on every keystroke until the `;` is typed.
 *
 * The grammar cannot be made to insert a MISSING ";" here — see
 * docs/superpowers/plans/2026-08-03-grammar-expression-cascade.md for the gate
 * result and the five disproven approaches.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";

function tableOf(src: string) {
  return buildSymbolTable(parse(src)!, "file:///a.pike", 1, undefined, src);
}

function declRange(src: string, name: string) {
  return tableOf(src).declarations.find(d => d.name === name);
}

function names(src: string): string[] {
  return tableOf(src).declarations.map(d => d.name).sort();
}

describe("a declaration's range stops at the statement it was written as", () => {
  beforeAll(async () => { await initParser(); });

  test("an unfinished initialiser does not extend the range onto the next line", () => {
    // No `;` — what the buffer looks like mid-keystroke.
    const x = declRange(`int main() {\n  int x = 1\n  int y = 2;\n  return y;\n}\n`, "x");
    expect(x).toBeDefined();
    expect(x!.range.start.line).toBe(1);
    expect(x!.range.end.line).toBe(1);
  });

  test("a complete declaration is unchanged", () => {
    const x = declRange(`int main() {\n  int x = 1;\n  int y = 2;\n  return y;\n}\n`, "x")!;
    expect(x.range.start.line).toBe(1);
    expect(x.range.end.line).toBe(1);
  });

  test("a legitimately multi-line declaration keeps its full range", () => {
    // No ERROR here — the range must not be clamped just because it spans lines.
    const m = declRange(
      `int main() {\n  mapping m = ([\n    "a": 1,\n  ]);\n  return 0;\n}\n`, "m")!;
    expect(m.range.start.line).toBe(1);
    expect(m.range.end.line).toBe(3);
  });

  test("the declaration itself is still found", () => {
    const x = declRange(`int main() {\n  int x = 1\n  return 0;\n}\n`, "x");
    expect(x?.declaredType).toBe("int");
  });
});

describe("a statement absorbed by an unfinished one is still declared", () => {
  beforeAll(async () => { await initParser(); });

  // What the buffer looks like while the `;` on line 1 is still untyped. The
  // parser folds `int y = 2;` into `x`'s initializer, so without recovery `y`
  // does not exist as a declaration at all.
  const TYPING = `int main() {\n  int x = 1\n  int y = 2;\n  return y;\n}\n`;
  const COMPLETE = `int main() {\n  int x = 1;\n  int y = 2;\n  return y;\n}\n`;

  test("the absorbed declaration is recovered", () => {
    expect(names(TYPING)).toEqual(names(COMPLETE));
  });

  test("it is recovered at its real position, with its real type", () => {
    const y = declRange(TYPING, "y");
    expect(y, "y must be declared").toBeDefined();
    expect(y!.nameRange.start.line).toBe(2);
    expect(y!.nameRange.start.character).toBe(6);
    expect(y!.declaredType).toBe("int");
  });

  test("it is declared once, not twice", () => {
    const ys = tableOf(TYPING).declarations.filter(d => d.name === "y");
    expect(ys).toHaveLength(1);
  });

  test("a run of unfinished statements recovers all of them", () => {
    const src = `int main() {\n  int a = 1\n  int b = 2\n  int c = 3;\n  return c;\n}\n`;
    expect(names(src)).toEqual(["a", "b", "c", "main"]);
  });

  test("complete source is untouched by the recovery", () => {
    const before = tableOf(COMPLETE).declarations
      .map(d => `${d.name}:${d.range.start.line}-${d.range.end.line}`).sort();
    expect(before).toEqual(["main:0-4", "x:1-1", "y:2-2"]);
  });

  test("an unfinished statement with nothing after it recovers nothing", () => {
    // No absorbed statement — the recovery must not invent one.
    const src = `int main() {\n  int x = 1\n}\n`;
    expect(names(src)).toEqual(["main", "x"]);
  });

  test("a multi-line initializer is not mistaken for an absorbed statement", () => {
    const src = `int main() {\n  mapping m = ([\n    "a": 1,\n  ]);\n  int z = 3;\n  return z;\n}\n`;
    expect(names(src)).toEqual(["m", "main", "z"]);
  });
});

// ---------------------------------------------------------------------------
// Through the LSP, not the symbol table
// ---------------------------------------------------------------------------

/**
 * The symbol-table tests above would still pass if the recovery never reached a
 * request handler. Verified against the real standalone server over stdio
 * before this was written: on the pre-fix build, go-to-definition on the
 * absorbed declaration answered NULL, completion did not offer it, and hover
 * was empty.
 */
describe("the recovered declaration is live over the protocol", () => {
  let server: TestServer;
  let root: string;
  let uri: string;

  // The `;` on line 1 is not typed yet — the state a buffer is in for most of
  // the time a statement is being written.
  const TYPING = `int main() {\n  int alpha = 1\n  int bravo = 2;\n  return bravo;\n}\n`;
  const lines = TYPING.split("\n");

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-absorbed-lsp-"));
    const file = join(root, "typing.pike");
    writeFileSync(file, TYPING);
    uri = pathToFileURL(file).href;
    server = await createTestServer({ rootUri: pathToFileURL(root).href });
    server.openDoc(uri, TYPING);
    await waitForFileEntry(server, [uri], 30000);
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const bravoUse = { line: 3, character: lines[3].indexOf("bravo") + 2 };

  test("go-to-definition reaches it", async () => {
    const res = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri }, position: bravoUse,
    }) as { range: { start: { line: number } } } | Array<{ range: { start: { line: number } } }> | null;
    const first = Array.isArray(res) ? res[0] : res;
    expect(first, "definition on the absorbed declaration").not.toBeNull();
    expect(first!.range.start.line).toBe(2);
  });

  test("hover knows its type", async () => {
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri }, position: bravoUse,
    }) as { contents: { value: string } } | null;
    expect(hover, "hover on the absorbed declaration").not.toBeNull();
    expect(hover!.contents.value).toMatch(/int\s+bravo/);
  });

  test("completion offers it", async () => {
    const res = await server.client.sendRequest("textDocument/completion", {
      textDocument: { uri },
      position: { line: 3, character: lines[3].indexOf("return") + 7 },
    }) as { items: Array<{ label: string }> } | Array<{ label: string }> | null;
    const items = (Array.isArray(res) ? res : res?.items ?? []).map(i => i.label);
    expect(items).toContain("bravo");
  });
});
