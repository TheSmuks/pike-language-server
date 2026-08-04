/**
 * Regression: every declarator in a comma-separated group must be visible, and
 * every enum member with an explicit value.
 *
 * The grammar bound a declarator's initializer to `_expr`, which admits
 * `comma_expr`. So `int a = 1, b = 2, c = 3;` parsed as ONE declarator named
 * `a` whose value was the comma expression `1, b = 2, c = 3` — `b` and `c` were
 * not declarators in the tree at all. Same for
 * `enum Colour { RED = 1, GREEN = 2, BLUE = 3 }`, where only RED survived.
 *
 * Everything downstream that walks declarators inherited the gap: the outline
 * listed one name, semantic tokens painted the rest as plain variables rather
 * than declarations/enumMembers, and completion, hover and go-to-definition
 * could not see them.
 *
 * The grammar's own golden for the case — a test named "Variable declaration -
 * multiple declarators" — recorded the collapsed tree, so it passed while
 * asserting the defect. Fixed upstream in /tank/projects/tree-sitter-pike by
 * giving comma-separated items a comma-free initializer rule.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";
import { pikeAvailable } from "../helpers/pikeAvailable";
import { execFileSync } from "node:child_process";
import { initParser, parse } from "../../server/src/parser";
import { getDocumentSymbols } from "../../server/src/features/documentSymbol";

const PIKE = process.env.PIKE_BINARY ?? "pike";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface DocumentSymbol { name: string; kind: number; range: Range; selectionRange: Range; children?: DocumentSymbol[] }
interface Location { uri: string; range: Range }

const SRC = `enum Colour { RED = 1, GREEN = 2, BLUE = 3 }

int a = 1, b = 2, c = 3;

int main() {
  write("%d %d %d %d\\n", a, b, c, GREEN);
  return 0;
}
`;

/** Every name in the outline, flattened. */
function names(symbols: DocumentSymbol[]): string[] {
  const out: string[] = [];
  const walk = (list: DocumentSymbol[]) => {
    for (const s of list) { out.push(s.name); if (s.children) walk(s.children); }
  };
  walk(symbols);
  return out;
}

describe("comma-separated declarators and enum members are all visible", () => {
  let server: TestServer;
  let root: string;
  let uri: string;
  let file: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-multidecl-"));
    file = join(root, "decls.pike");
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

  test.skipIf(!pikeAvailable)("pike is the oracle: all six names really are declared", () => {
    // If the tree were right and the source wrong, this would fail first.
    const out = execFileSync(PIKE, [file], { encoding: "utf8" });
    expect(out.trim()).toBe("1 2 3 2");
  });

  test("documentSymbol lists every declarator", async () => {
    const symbols = await server.client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    }) as DocumentSymbol[];
    const found = names(symbols);
    for (const name of ["a", "b", "c"]) {
      expect(found, `declarator ${name} missing from the outline`).toContain(name);
    }
  });

  test("documentSymbol lists every enum member", async () => {
    const symbols = await server.client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    }) as DocumentSymbol[];
    const found = names(symbols);
    for (const name of ["RED", "GREEN", "BLUE"]) {
      expect(found, `enum member ${name} missing from the outline`).toContain(name);
    }
  });

  test("go-to-definition reaches a declarator that is not the first", async () => {
    // `c` in the write() call on line 5.
    const line = SRC.split("\n")[5];
    const character = line.lastIndexOf("c,") >= 0 ? line.lastIndexOf("c,") : line.indexOf("c");
    const res = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri }, position: { line: 5, character },
    }) as Location | Location[] | null;
    const first = Array.isArray(res) ? res[0] : res;
    expect(first, "definition on c must resolve").not.toBeNull();
    // The declaration is on line 2, and `c` is the third declarator.
    expect(first!.range.start.line).toBe(2);
    expect(SRC.split("\n")[2].slice(
      first!.range.start.character, first!.range.start.character + 1,
    )).toBe("c");
  });

  test("hover on a later enum member describes that member", async () => {
    const line = SRC.split("\n")[0];
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri }, position: { line: 0, character: line.indexOf("GREEN") + 1 },
    }) as { contents: { value: string } } | null;
    expect(hover?.contents?.value ?? "", "hover on GREEN").toContain("GREEN");
  });
});

test("anonymous enum members are top-level document symbols", async () => {
  await initParser();
  const tree = parse("enum { TRACE = 10, INFO = 20, ERROR = 30 };\n")!;
  try {
    expect(names(getDocumentSymbols(tree))).toEqual(["TRACE", "INFO", "ERROR"]);
  } finally {
    tree.delete();
  }
});
