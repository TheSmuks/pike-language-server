/**
 * Regression: hover must describe the symbol under the cursor, and say so with
 * a range in the document the user is looking at.
 *
 *  - Hover.range is defined by LSP as a range in the hovered document, used to
 *    visualise the hover. Each tier derived it from whatever it resolved: a
 *    declaration on another line, a declaration in another FILE (line 950 of a
 *    103-line document), or the raw cursor column, which sliced the identifier
 *    and spilled into the next tokens.
 *  - The stdlib reverse index is keyed on the LAST segment of an FQN, so a bare
 *    name maps to many symbols. Taking the first with docs takes them in
 *    insertion order, i.e. alphabetically by FQN: `Stdio.File` was documented
 *    as `Bz2.File.File`'s inherit, and `Array.map` as `ADT.Relation.Binary.map`
 *    ("Maps every entry in the relation").
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";
import { hoveredIdentifierRange } from "../../server/src/features/hoverRange";
import { getUniqueStdlibEntryByName, getStdlibEntriesByName } from "../../server/src/features/completion-stdlib";
import stdlibAutodocIndexRaw from "../../server/src/data/stdlib-autodoc.json";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface HoverResult { contents: { value: string }; range?: Range }

const SRC = `int main() {
  Stdio.File f = Stdio.File();
  array r = Array.map(({1}), lambda(int i){ return i; });
  string name = "n";
  write("%s", name);
  return 0;
}
`;

describe("hoveredIdentifierRange", () => {
  const line = "  write(\"x\");";

  test("finds the whole word from anywhere inside it", () => {
    for (const character of [2, 3, 4, 5, 6]) {
      expect(hoveredIdentifierRange(line, { line: 0, character }))
        .toEqual({ start: { line: 0, character: 2 }, end: { line: 0, character: 7 } });
    }
  });

  test("a cursor resting just past the word still finds it", () => {
    expect(hoveredIdentifierRange(line, { line: 0, character: 7 }))
      .toEqual({ start: { line: 0, character: 2 }, end: { line: 0, character: 7 } });
  });

  test("returns null rather than inventing a range off the word", () => {
    expect(hoveredIdentifierRange(line, { line: 0, character: 0 })).toBeNull();
    expect(hoveredIdentifierRange(line, { line: 5, character: 0 })).toBeNull();
  });
});

describe("hover answers about the symbol under the cursor", () => {
  let server: TestServer;
  let root: string;
  let uri: string;
  const lines = SRC.split("\n");

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-hover-range-"));
    const file = join(root, "h.pike");
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

  /** Hover the middle of the `occurrence`-th whole-word match of `word`. */
  async function hoverWord(word: string, line: number, occurrence = 0): Promise<HoverResult | null> {
    const re = new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`, "g");
    const cols = [...lines[line].matchAll(re)].map(m => m.index!);
    const col = cols[occurrence];
    expect(col, `${word} on line ${line}`).toBeDefined();
    return await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line, character: col + Math.floor(word.length / 2) },
    }) as HoverResult | null;
  }

  const cases: Array<[string, string, number]> = [
    ["a stdlib class in an expression", "File", 1],
    ["a stdlib function call", "map", 2],
    ["a use of a local variable", "name", 4],
  ];

  for (const [label, word, line] of cases) {
    test(`range covers the hovered token and nothing else — ${label}`, async () => {
      const hover = await hoverWord(word, line);
      expect(hover, label).not.toBeNull();
      expect(hover!.range, `${label} range`).toBeDefined();
      const r = hover!.range!;
      // Inside the document...
      expect(r.start.line).toBeLessThan(lines.length);
      // ...and exactly the word that was hovered.
      expect(lines[r.start.line].slice(r.start.character, r.end.character)).toBe(word);
    });
  }

  test("Array.map is not documented as a relation method", async () => {
    const hover = await hoverWord("map", 2);
    expect(hover).not.toBeNull();
    // ADT.Relation.Binary.map's markdown; Array.map is the predef `map`,
    // confirmed with the pike binary (`Array.map == map` -> 1).
    expect(hover!.contents.value).not.toContain("Maps every entry in the relation");
  });

  test("Stdio.File is not documented as Bz2's inherit", async () => {
    const hover = await hoverWord("File", 1);
    expect(hover).not.toBeNull();
    expect(hover!.contents.value.trim()).not.toBe("```pike\ninherit File\n```");
  });
});

describe("getUniqueStdlibEntryByName declines ambiguous names", () => {
  const index = stdlibAutodocIndexRaw as unknown as Record<string, unknown>;

  test("a name carried by several modules resolves to nothing", () => {
    // Guard the guard: these names must really be ambiguous in the shipped
    // index, or the test proves nothing.
    for (const name of ["File", "map"]) {
      const all = getStdlibEntriesByName(index as never, name) ?? [];
      const distinct = new Set(all.map(m => m.fqn));
      expect(distinct.size, `${name} should be ambiguous`).toBeGreaterThan(1);
      expect(getUniqueStdlibEntryByName(index as never, name)).toBeNull();
    }
  });

  test("an unambiguous name still resolves", () => {
    // Find any name with exactly one entry and check it comes back.
    let checked = false;
    for (const fqn of Object.keys(index).slice(0, 4000)) {
      const tail = fqn.split(".").pop()!;
      const all = getStdlibEntriesByName(index as never, tail) ?? [];
      if (new Set(all.map(m => m.fqn)).size !== 1) continue;
      expect(getUniqueStdlibEntryByName(index as never, tail)?.fqn).toBe(all[0].fqn);
      checked = true;
      break;
    }
    expect(checked, "expected at least one unambiguous stdlib name").toBe(true);
  });
});
