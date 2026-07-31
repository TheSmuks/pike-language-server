/**
 * Each `::` qualifier selects a different scope, and Pike distinguishes them.
 *
 * Oracle, `pown.pike` inheriting `pbase.pike` with both declaring `who()`:
 *
 *     plain=OWN  bare=INHERITED  this_program=OWN  this=OWN  local=OWN
 *     this_program::onlyparent() = ONLY-IN-PARENT
 *
 * so a bare `::` is the ONLY qualifier that skips the program's own
 * declaration, and the other three fall back to the inherited one only when
 * the program has none of its own.
 *
 * The server used to read `this::`, `this_program::` and `local::` as a bare
 * `::`, because the grammar emits all of them as anonymous tokens and the test
 * for "bare" was "has no `identifier` child". Every one of them therefore
 * answered with the INHERITED declaration — a wrong answer, not a missing one.
 *
 * Two further rules the oracle settles, both of them about names:
 *
 * - `inherit .mm.Session : parent;` then `Session::timeout` →
 *   `No inherit or surrounding class Session.` An alias REPLACES the name.
 *   Drop the `: parent` and the same line prints `120`.
 * - A surrounding class is a legal qualifier: `class Session { int maxtime=1,
 *   timeout=2; class SessionQuery { … Session::maxtime … } }` prints `12`.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const PBASE_SRC = `string who() { return "INHERITED"; }
string onlyparent() { return "ONLY-IN-PARENT"; }
`;

// Line 3 (index 2) exercises all four qualifiers against the same name.
const POWN_SRC = `inherit "pbase";
string who() { return "OWN"; }
string probe() { return ::who() + this_program::who() + this::who() + local::who(); }
string fallback() { return this_program::onlyparent(); }
`;

// An aliased inherit, and a surrounding class used as a qualifier.
const ALIAS_SRC = `class Outer
{
  inherit "pbase" : parent;
  string who() { return "OUTER"; }

  class Nested
  {
    string byOuter() { return Outer::who(); }
    string byAlias() { return parent::who(); }
    string byTail() { return pbase::who(); }
  }
}
`;

interface DefinitionResult { uri: string; range: { start: { line: number } } }

let tempRoot: string;
let pownUri: string;
let aliasUri: string;
let server: TestServer;

async function definitionAt(
  uri: string,
  line: number,
  character: number,
): Promise<DefinitionResult | null> {
  const result = await server.client.sendRequest("textDocument/definition", {
    textDocument: { uri },
    position: { line, character },
  });
  if (!result) return null;
  return (Array.isArray(result) ? result[0] : result) as DefinitionResult;
}

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "pike-scope-kinds-"));
  writeFileSync(join(tempRoot, "pbase.pike"), PBASE_SRC);
  writeFileSync(join(tempRoot, "pown.pike"), POWN_SRC);
  writeFileSync(join(tempRoot, "alias.pike"), ALIAS_SRC);

  pownUri = pathToFileURL(join(tempRoot, "pown.pike")).href;
  aliasUri = pathToFileURL(join(tempRoot, "alias.pike")).href;

  server = await createTestServer({ rootUri: pathToFileURL(tempRoot).href });
  server.openDoc(pathToFileURL(join(tempRoot, "pbase.pike")).href, PBASE_SRC);
  server.openDoc(pownUri, POWN_SRC);
  server.openDoc(aliasUri, ALIAS_SRC);
});

afterAll(async () => {
  await server.teardown();
  rmSync(tempRoot, { recursive: true, force: true });
});

// `string probe() { return ::who() + this_program::who() + this::who() + local::who(); }`
//   column:                   26              48                  62            77
const BARE = 26;
const THIS_PROGRAM = 48;
const THIS = 62;
const LOCAL = 77;

describe("qualifier keywords name the current program, bare :: names the inherit", () => {
  test("bare :: answers the INHERITED declaration", async () => {
    const def = await definitionAt(pownUri, 2, BARE);
    expect(def).not.toBeNull();
    expect(def!.uri).toEndWith("pbase.pike");
  });

  for (const [label, column] of [
    ["this_program::", THIS_PROGRAM], ["this::", THIS], ["local::", LOCAL],
  ] as const) {
    test(`${label} answers the program's OWN declaration`, async () => {
      const def = await definitionAt(pownUri, 2, column);
      expect(def).not.toBeNull();
      expect(def!.uri).toEndWith("pown.pike");
      expect(def!.range.start.line).toBe(1);
    });
  }

  test("this_program:: still reaches a name only the parent declares", async () => {
    // `string fallback() { return this_program::onlyparent(); }`
    const def = await definitionAt(pownUri, 3, 41);
    expect(def).not.toBeNull();
    expect(def!.uri).toEndWith("pbase.pike");
  });
});

describe("a surrounding class is a legal qualifier", () => {
  test("Outer::who from a nested class answers the outer class's own member", async () => {
    // `    string byOuter() { return Outer::who(); }`
    const def = await definitionAt(aliasUri, 7, 37);
    expect(def).not.toBeNull();
    expect(def!.uri).toEndWith("alias.pike");
    expect(def!.range.start.line).toBe(3);
  });
});

describe("an alias replaces the inherit's name", () => {
  test("the alias resolves", async () => {
    // `    string byAlias() { return parent::who(); }`
    const def = await definitionAt(aliasUri, 8, 38);
    expect(def).not.toBeNull();
    expect(def!.uri).toEndWith("pbase.pike");
  });

  test("the path tail of an ALIASED inherit does not", async () => {
    // `    string byTail() { return pbase::who(); }` — Pike refuses to compile
    // this with `No inherit or surrounding class pbase.`, so answering it
    // points at a declaration the expression does not name.
    expect(await definitionAt(aliasUri, 9, 36)).toBeNull();
  });
});
