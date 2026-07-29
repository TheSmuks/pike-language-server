/**
 * Non-ASCII position correctness.
 *
 * tree-sitter and LSP both index in UTF-16 code units, so positions must pass
 * through unconverted. While the conversion layer existed, every range shifted
 * LEFT by one per non-ASCII character preceding the token on its own line, and
 * every lookup shifted RIGHT by the same amount — which is why hovering one
 * symbol could return the documentation for a different one.
 *
 * Measured against the pre-fix build:
 *   - "helper" at true index 12 was reported at 11
 *   - "main" at true index 13 (two © before it) was reported at 11
 *   - hovering "alpha" at its true index returned "int beta()"
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";

interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}
interface Sym { name: string; range: Range; selectionRange: Range }
interface HoverResult { contents: { value: string } | string; range?: Range }
interface LocationResult { uri: string; range: Range }

let server: TestServer;

beforeAll(async () => { server = await createTestServer(); });
afterAll(async () => { await server.teardown(); });

// One © before "helper" on line 0; two © before "main" on line 1.
const OUTBOUND = [
  '/* © */ int helper() { return 1; }',
  '/* ©© */ int main() { return helper(); }',
].join('\n');

// Ten © before the call site, enough that a right-shifted lookup on "alpha"
// lands squarely on "beta".
const INBOUND = [
  'int alpha() { return 1; }',
  'int beta() { return 2; }',
  '/* ©©©©©©©©©© */ int main() { return alpha() + beta(); }',
].join('\n');

describe("outbound ranges are not shifted by non-ASCII on the same line", () => {
  test("declaration ranges match their true UTF-16 indices", async () => {
    const uri = server.openDoc("file:///test/nonascii-outbound.pike", OUTBOUND);

    const syms = await server.client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    }) as Sym[] | null;

    expect(syms).not.toBeNull();

    const lines = OUTBOUND.split('\n');
    const helper = syms!.find(s => s.name === "helper");
    expect(helper).toBeDefined();
    // "/* © */ int helper() ..." — "helper" is at UTF-16 index 12.
    expect(lines[0]!.indexOf("helper")).toBe(12);
    expect(helper!.selectionRange.start.character).toBe(12);
    expect(helper!.selectionRange.end.character).toBe(18);

    const main = syms!.find(s => s.name === "main");
    expect(main).toBeDefined();
    // "/* ©© */ int main() ..." — "main" is at UTF-16 index 13.
    expect(lines[1]!.indexOf("main")).toBe(13);
    expect(main!.selectionRange.start.character).toBe(13);
    expect(main!.selectionRange.end.character).toBe(17);
  });

  test("an ASCII-only control file is unaffected", async () => {
    // Same layout, © replaced by spaces, so indices shift but nothing drifts.
    const control = [
      '/*   */ int helper() { return 1; }',
      '/*    */ int main() { return helper(); }',
    ].join('\n');
    const uri = server.openDoc("file:///test/nonascii-control.pike", control);

    const syms = await server.client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    }) as Sym[] | null;

    const helper = syms!.find(s => s.name === "helper");
    expect(helper!.selectionRange.start.character).toBe(12);
    const main = syms!.find(s => s.name === "main");
    expect(main!.selectionRange.start.character).toBe(13);
  });
});

describe("inbound lookups resolve the token actually at the position", () => {
  test("hover on a call returns that function, not its neighbour", async () => {
    const uri = server.openDoc("file:///test/nonascii-inbound.pike", INBOUND);
    const line2 = INBOUND.split('\n')[2]!;
    const alphaAt = line2.indexOf("alpha");
    expect(alphaAt).toBe(37); // guard: the fixture must not drift silently

    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: 2, character: alphaAt },
    }) as HoverResult | null;

    expect(hover).not.toBeNull();
    const text = typeof hover!.contents === "string"
      ? hover!.contents
      : hover!.contents.value;
    expect(text).toContain("alpha");
    expect(text).not.toContain("beta"); // pre-fix, this returned "int beta()"
  });

  test("hover on the second call resolves rather than returning null", async () => {
    const uri = server.openDoc("file:///test/nonascii-inbound2.pike", INBOUND);
    const line2 = INBOUND.split('\n')[2]!;
    const betaAt = line2.indexOf("beta");
    expect(betaAt).toBe(47);

    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: 2, character: betaAt },
    }) as HoverResult | null;

    expect(hover).not.toBeNull(); // pre-fix, the shifted lookup fell off the end
    const text = typeof hover!.contents === "string"
      ? hover!.contents
      : hover!.contents.value;
    expect(text).toContain("beta");
  });

  test("go-to-definition from a shifted call lands on the right declaration", async () => {
    const uri = server.openDoc("file:///test/nonascii-def.pike", INBOUND);
    const line2 = INBOUND.split('\n')[2]!;

    const def = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 2, character: line2.indexOf("alpha") },
    }) as LocationResult | LocationResult[] | null;

    expect(def).not.toBeNull();
    const loc = Array.isArray(def) ? def[0]! : def!;
    // "int alpha()" is line 0; "alpha" starts at character 4.
    expect(loc.range.start.line).toBe(0);
    expect(loc.range.start.character).toBe(4);
  });
});
