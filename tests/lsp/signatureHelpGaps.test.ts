/**
 * Regression: five signature-help defects found by sweeping real Roxen code.
 *
 * Four produced a wrong answer rather than no answer, which is the worse
 * failure: the popup is open and confidently misleading.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";
import { resolvePredefSignatures } from "../../server/src/features/signatureHelp-resolve";
import predefBuiltins from "../../server/src/data/predef-builtin-index.json";
import predefAutodoc from "../../server/src/data/predef-autodoc.json";

interface SigHelp {
  signatures: Array<{ label: string; parameters?: Array<{ label: string }> }>;
  activeSignature?: number;
  activeParameter?: number;
}

const SRC = `string join_strings(string sep, string ... parts)
{
  return parts * sep;
}

void greet(string greeting, int times) { }

mixed query(mixed args) { return args; }

class Box {
  int query(int a, string b) { return a; }
}

int main()
{
  greet("hi", 2);
  string s = join_strings("-", "a", "b");
  greet(sprintf("%d", sizeof(({1,2}))), 3);
  Box b = Box();
  b->query(7, "x");
  return 0;
}
`;

describe("signature help", () => {
  let server: TestServer;
  let root: string;
  let uri: string;
  const lines = SRC.split("\n");

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-sighelp-"));
    const file = join(root, "s.pike");
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

  function lineOf(fragment: string): number {
    const i = lines.findIndex(l => l.includes(fragment));
    expect(i, `fixture line containing ${fragment}`).toBeGreaterThanOrEqual(0);
    return i;
  }

  async function sig(line: number, character: number): Promise<SigHelp | null> {
    return await server.client.sendRequest("textDocument/signatureHelp", {
      textDocument: { uri }, position: { line, character },
    }) as SigHelp | null;
  }

  test("the caret just before ')' is still inside the call", async () => {
    const line = lineOf('greet("hi", 2)');
    const close = lines[line].indexOf(")");

    const before = await sig(line, close - 1);
    const onParen = await sig(line, close);

    expect(before?.signatures?.[0]?.label).toContain("greet");
    // This position used to answer null, or the enclosing call's signature.
    expect(onParen?.signatures?.[0]?.label).toBe(before!.signatures[0].label);
    expect(onParen?.activeParameter).toBe(before!.activeParameter!);
  });

  test("commas inside an argument are not argument separators", async () => {
    // `greet(sprintf("%d", sizeof(({1,2}))), 3);` — three commas precede the
    // cursor but only one separates greet's arguments.
    const line = lineOf("greet(sprintf");
    const help = await sig(line, lines[line].lastIndexOf("3"));

    expect(help?.signatures?.[0]?.label).toContain("greet");
    expect(help!.activeParameter).toBe(1);
    // activeParameter past the end leaves the client highlighting nothing.
    expect(help!.activeParameter!).toBeLessThan(help!.signatures[0].parameters!.length);
  });

  test("a variadic parameter is shown as variadic", async () => {
    const line = lineOf('join_strings("-"');
    const help = await sig(line, lines[line].indexOf('"-"') + 1);

    expect(help?.signatures?.[0]?.label)
      .toBe("string join_strings(string sep, string ... parts)");
  });

  test("a call through a receiver resolves in the receiver's type", async () => {
    // Both a file-scope `query(mixed args)` and `Box::query(int, string)`
    // exist, and an unrelated `string b` parameter shadows the local `Box b`
    // by name. Neither may decide the answer.
    const line = lineOf("b->query(7");
    const help = await sig(line, lines[line].indexOf("(") + 1);

    expect(help?.signatures?.[0]?.label).toContain("int a");
    expect(help?.signatures?.[0]?.label).not.toContain("mixed args");
  });
});

describe("predef overloads parse out of the raw type descriptor", () => {
  const ctx = { predefBuiltins, predefAutodoc } as never;

  test("min and max yield real call shapes, not raw type text", () => {
    for (const name of ["min", "max"]) {
      const sigs = resolvePredefSignatures(name, ctx);
      expect(sigs.length, `${name} overloads`).toBeGreaterThan(1);
      for (const s of sigs) {
        // The old output was the raw descriptor: unbalanced, full of `!function`.
        expect(s.label).not.toContain("!function");
        expect(s.label.startsWith(name) || s.label.includes(` ${name}(`)).toBe(true);
      }
      // At least one overload must actually take arguments.
      expect(sigs.some(s => s.parameters.length > 0)).toBe(true);
    }
  });

  test("simple efuns still resolve", () => {
    for (const name of ["sizeof", "write", "sprintf"]) {
      const sigs = resolvePredefSignatures(name, ctx);
      expect(sigs.length, name).toBeGreaterThan(0);
      expect(sigs[0].parameters.length, name).toBeGreaterThan(0);
    }
  });

  test("no duplicate call shapes", () => {
    for (const name of ["min", "max", "write"]) {
      const labels = resolvePredefSignatures(name, ctx).map(s => s.label);
      expect(labels.length).toBe(new Set(labels).size);
    }
  });
});
