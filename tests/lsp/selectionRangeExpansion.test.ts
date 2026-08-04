/**
 * Regression: expand-selection must widen through the real syntactic parents.
 *
 * MEANINGFUL_TYPES listed 41 node types, of which 24 did not exist in the
 * grammar — `function_definition`, `class_definition`, `variable_declaration`,
 * `call_expression`, `binary_expression`, `source_file` and friends, none of
 * which tree-sitter-pike ever produces. Every declaration and expression node
 * therefore failed the filter, and expand-selection answered with a single
 * range covering the entire file.
 *
 * The names are cross-checked against server/src/grammar.json here, so a
 * grammar rename cannot silently reintroduce the same class of dead entry.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface SelectionRange { range: Range; parent?: SelectionRange }

const SRC = `int compute(int a, int b) { return a + b; }

int main() {
  int total = compute(1, 2) + 3;
  return total;
}
`;

/** Flatten the parent chain into an array, innermost first. */
function chain(node: SelectionRange): Range[] {
  const out: Range[] = [];
  let cur: SelectionRange | undefined = node;
  while (cur) { out.push(cur.range); cur = cur.parent; }
  return out;
}

/** Is `inner` contained in `outer`? */
function contains(outer: Range, inner: Range): boolean {
  const afterStart = outer.start.line < inner.start.line ||
    (outer.start.line === inner.start.line && outer.start.character <= inner.start.character);
  const beforeEnd = outer.end.line > inner.end.line ||
    (outer.end.line === inner.end.line && outer.end.character >= inner.end.character);
  return afterStart && beforeEnd;
}

describe("selectionRange expands through real syntax nodes", () => {
  let server: TestServer;
  let root: string;
  let uri: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-selrange-"));
    const file = join(root, "sel.pike");
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

  async function rangesAt(line: number, character: number): Promise<Range[]> {
    const res = await server.client.sendRequest("textDocument/selectionRange", {
      textDocument: { uri }, positions: [{ line, character }],
    }) as SelectionRange[] | null;
    expect(res, "selectionRange must answer").not.toBeNull();
    return chain(res![0]);
  }

  test("a name inside a nested call widens step by step", async () => {
    // `compute` inside `int total = compute(1, 2) + 3;`
    const ranges = await rangesAt(3, 16);
    expect(ranges.length, "must widen more than once").toBeGreaterThan(2);
    // The innermost range must not already be the whole file.
    expect(ranges[0].end.line - ranges[0].start.line, "innermost must be small").toBeLessThan(2);
  });

  test("the chain is strictly nested and never shrinks", async () => {
    const ranges = await rangesAt(3, 16);
    for (let i = 1; i < ranges.length; i++) {
      expect(contains(ranges[i], ranges[i - 1]),
        `range ${i} must contain range ${i - 1}: ${JSON.stringify(ranges[i])} vs ${JSON.stringify(ranges[i - 1])}`)
        .toBe(true);
    }
  });

  test("a declaration name widens before reaching the file", async () => {
    // `compute` in its own declaration on line 0.
    const ranges = await rangesAt(0, 5);
    expect(ranges.length).toBeGreaterThan(1);
    expect(ranges[0].start.line).toBe(0);
    expect(ranges[0].end.line - ranges[0].start.line).toBeLessThan(1);
  });

  test("every configured node type exists in the grammar", () => {
    const grammar = JSON.parse(
      readFileSync(join(import.meta.dir, "../../server/src/grammar.json"), "utf8"),
    ) as { rules: Record<string, unknown> };
    const source = readFileSync(
      join(import.meta.dir, "../../server/src/features/selectionRange.ts"), "utf8",
    );
    const start = source.indexOf("const MEANINGFUL_TYPES");
    const block = source.slice(start, source.indexOf("]);", start));
    const listed = [...block.matchAll(/"([a-z_]+)"/g)].map(m => m[1]);

    expect(listed.length, "the list must not be empty").toBeGreaterThan(0);
    const missing = listed.filter(n => !(n in grammar.rules));
    expect(missing, `node types absent from the grammar: ${missing.join(", ")}`).toEqual([]);
  });
});
