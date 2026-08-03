/**
 * Regression: document highlight painted ranges that are not in this document,
 * and completion lost the member list — and its edit ranges — the moment a
 * prefix was typed.
 *
 * The completion defect is the destructive one: every item carried a backwards
 * two-line range, so accepting one deleted the line break and the start of the
 * following line.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface CompletionItem { label: string; textEdit?: { range: Range } }
interface CompletionList { items: CompletionItem[]; isIncomplete: boolean }

const BASE = `class Animal {
  string name;
  void create(string n) { name = n; }
  string speak() { return "..."; }
}
`;

const DERIVED = `inherit "base.pike";

class Dog {
  inherit Animal;
  void create(string n) {
    ::create(n);
  }
}
`;

// Held mid-typing: the statement has no terminator yet, which is what a buffer
// looks like while the user is choosing a completion.
const TYPING = `class Shape {
  string name;
  int leaf;
  int area() { return 0; }
}

int main() {
  Shape s = Shape();
  string n = s->na
  return 0;
}
`;

describe("document highlight stays inside this document", () => {
  let server: TestServer;
  let root: string;
  let derivedUri: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-hl-"));
    writeFileSync(join(root, "base.pike"), BASE);
    writeFileSync(join(root, "derived.pike"), DERIVED);
    const baseUri = pathToFileURL(join(root, "base.pike")).href;
    derivedUri = pathToFileURL(join(root, "derived.pike")).href;
    server = await createTestServer({ rootUri: pathToFileURL(root).href });
    server.openDoc(baseUri, BASE);
    server.openDoc(derivedUri, DERIVED);
    await waitForFileEntry(server, [baseUri, derivedUri], 30000);
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("a declaration inherited from another file is not painted here", async () => {
    const lines = DERIVED.split("\n");
    const line = lines.findIndex(l => l.includes("::create("));
    const col = lines[line].indexOf("create");

    const highlights = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri: derivedUri }, position: { line, character: col + 2 },
    }) as Array<{ range: Range }>;

    for (const h of highlights ?? []) {
      const text = lines[h.range.start.line]
        ?.slice(h.range.start.character, h.range.end.character);
      // The inherited declaration lives at another file's coordinates; painting
      // it here put a six-character range on a blank line.
      expect(text).toBe("create");
    }
  });

  test("the occurrence under the cursor is always highlighted", async () => {
    const lines = DERIVED.split("\n");
    const line = lines.findIndex(l => /^\s*inherit\s+Animal\s*;/.test(l));
    const col = lines[line].indexOf("Animal");

    const highlights = await server.client.sendRequest("textDocument/documentHighlight", {
      textDocument: { uri: derivedUri }, position: { line, character: col + 2 },
    }) as Array<{ range: Range }>;

    expect(highlights?.some(
      h => h.range.start.line === line && h.range.start.character === col,
    ), "the inherit clause the cursor is on").toBe(true);
  });
});

describe("completion while a member name is being typed", () => {
  let server: TestServer;
  let root: string;
  let uri: string;
  const lines = TYPING.split("\n");
  const line = lines.findIndex(l => l.includes("s->na"));
  const arrowEnd = lines[line].indexOf("->") + 2;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-comp-"));
    const file = join(root, "c.pike");
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

  async function complete(character: number): Promise<CompletionItem[]> {
    const res = await server.client.sendRequest("textDocument/completion", {
      textDocument: { uri }, position: { line, character },
    }) as CompletionList | CompletionItem[] | null;
    return Array.isArray(res) ? res : res?.items ?? [];
  }

  test("the member list survives typing a prefix", async () => {
    const afterArrow = await complete(arrowEnd);
    const afterPrefix = await complete(arrowEnd + 2);   // `s->na`

    const members = ["name", "leaf", "area"];
    for (const m of members) {
      expect(afterArrow.map(i => i.label), `${m} right after ->`).toContain(m);
      // The member being typed used to vanish into the global scope list.
      expect(afterPrefix.map(i => i.label), `${m} after typing "na"`).toContain(m);
    }
    // It must still be a member list, not everything in scope.
    expect(afterPrefix.length).toBeLessThanOrEqual(afterArrow.length);
  });

  test("no completion edit range is backwards or crosses a line", async () => {
    for (const character of [arrowEnd, arrowEnd + 1, arrowEnd + 2]) {
      for (const item of await complete(character)) {
        const range = item.textEdit?.range;
        if (!range) continue;
        expect(range.start.line, `${item.label} start line`).toBe(line);
        expect(range.end.line, `${item.label} end line`).toBe(line);
        expect(range.start.character,
          `${item.label} range is backwards`).toBeLessThanOrEqual(range.end.character);
      }
    }
  });
});
