/**
 * Hover on the `::` itself, on the qualifier keyword before it, and on a
 * member behind an alias of a class the workspace cannot open.
 *
 * All three answered nothing. The grammar emits `predef`, `global`, `this`,
 * `this_program` and `local` as ANONYMOUS tokens inside `inherit_specifier`,
 * so every hover tier that looks for an `identifier` node walks past them —
 * `this_program::logger_name` in Roxen's `Logger.pmod` hovered on the member
 * and not on the qualifier that selects its scope. `::` was the same, at all
 * ~120 `::` sites in Roxen 6.1, though one column either side answered.
 *
 * The third is the price of making the qualifier binding: `inherit
 * Parser.HTML : low_parser;` names a C class with no file to index, so
 * `low_parser::add_container` has no workspace declaration. The running Pike
 * does know it — `indices(Parser.HTML())` lists all 54 members — so the answer
 * comes from the worker rather than from a same-named symbol elsewhere.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const BASE_SRC = `string who() { return "BASE"; }
`;

const MAIN_SRC = `inherit "base";
inherit Parser.HTML : low_parser;
int fileval = 7;

class Inner
{
  string bare() { return ::who(); }
  int viaGlobal() { return global::fileval; }
  string viaProgram() { return this_program::who(); }
  int viaPredef() { return predef::sizeof(({})); }
  object outer() { return global::this; }
}

string lowLevel() { return low_parser::add_container("x", 0); }
`;

interface HoverResult { contents: { value: string } }

let tempRoot: string;
let mainUri: string;
let server: TestServer;

async function hoverAt(line: number, character: number): Promise<HoverResult | null> {
  return await server.client.sendRequest("textDocument/hover", {
    textDocument: { uri: mainUri },
    position: { line, character },
  }) as HoverResult | null;
}

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "pike-scope-hover-"));
  writeFileSync(join(tempRoot, "base.pike"), BASE_SRC);
  writeFileSync(join(tempRoot, "main.pike"), MAIN_SRC);

  mainUri = pathToFileURL(join(tempRoot, "main.pike")).href;
  server = await createTestServer({ rootUri: pathToFileURL(tempRoot).href });
  server.openDoc(pathToFileURL(join(tempRoot, "base.pike")).href, BASE_SRC);
  server.openDoc(mainUri, MAIN_SRC);
});

afterAll(async () => {
  await server.teardown();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("hover on the qualifier keyword before ::", () => {
  test("global:: names the file's own top-level scope", async () => {
    // `  int viaGlobal() { return global::fileval; }` — cursor on `global`.
    const hover = await hoverAt(7, 29);
    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("global::");
    expect(hover!.contents.value).toContain("file");
  });

  test("this_program:: names the program being compiled", async () => {
    // `  string viaProgram() { return this_program::who(); }`
    const hover = await hoverAt(8, 35);
    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("this_program::");
  });

  test("predef:: names Pike's predefined scope", async () => {
    // `  int viaPredef() { return predef::sizeof(({})); }`
    const hover = await hoverAt(9, 29);
    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("predef::");
    expect(hover!.contents.value).toContain("builtin");
  });
});

describe("hover on the :: token itself", () => {
  test("a bare :: names what the program inherits", async () => {
    // `  string bare() { return ::who(); }` — cursor on the first colon.
    const hover = await hoverAt(6, 25);
    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("inherited scope");
  });
});

describe("hover on `this` used as the member of a scoped access", () => {
  test("global::this names the file's own object", async () => {
    // `  object outer() { return global::this; }`
    const hover = await hoverAt(10, 34);
    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("file's own object");
  });
});

describe("hover on a member behind an alias of a stdlib class", () => {
  test("names the class the qualifier actually selects", async () => {
    // `string lowLevel() { return low_parser::add_container("x", 0); }`
    const hover = await hoverAt(13, 39);
    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("Parser.HTML");
    expect(hover!.contents.value).toContain("add_container");
  });

  test("does not answer from a same-named symbol elsewhere", async () => {
    // `who` is declared in base.pike, which this file also inherits — but
    // `low_parser::` does not name that inherit, and Pike rejects the
    // combination outright. Nothing is a better answer than base.pike's.
    const hover = await hoverAt(13, 39);
    expect(hover!.contents.value).not.toContain("base.pike");
  });
});
