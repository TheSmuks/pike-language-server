/**
 * `A::name` must answer with A's `name` — or with nothing.
 *
 * The qualifier of a scoped access is binding. Pike 8.0.1116 is the oracle:
 * with `inherit "oa" : A; inherit "ob" : B;`, `A::shared()` and `B::shared()`
 * print `1 2` — different functions — and `A::only_b()` does not compile at
 * all:
 *
 *     od.pike:3:Undefined identifier A::only_b.
 *
 * The server used to ignore the qualifier entirely once the enclosing program
 * was the FILE rather than a class. `resolveScoped` bailed (no class scope),
 * the reference was left unresolved, and the cross-file fallback then searched
 * *every* inherit for the bare name — so `B::shared` answered oa.pike's
 * `shared` and `B::only_a` answered a declaration Pike rejects outright.
 *
 * Those are wrong answers, not missing ones, and they are what Roxen's
 * `RXML.pmod/PXml.pike` hit: `low_parser::add_tag` (an alias of the stdlib
 * `Parser.HTML`) resolved to `RXML.TagSetParser`'s unrelated `add_tag`.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const OA_SRC = `int shared() { return 1; }
int only_a() { return 11; }
`;

const OB_SRC = `int shared() { return 2; }
int only_b() { return 22; }
`;

// Two file-level inherits, both aliased. Every lookup below has a definite
// answer under the real compiler.
const OE_SRC = `inherit "oa" : A;
inherit "ob" : B;
int probe()
{
  return A::shared() + B::shared() + B::only_a() + A::only_a();
}
`;

// The same shape one level down: the qualifier names a class-level inherit.
const CLS_SRC = `class Both
{
  inherit "oa" : A;
  inherit "ob" : B;

  int probe() { return B::shared(); }
}
`;

interface DefinitionResult { uri: string; range: { start: { line: number } } }

let tempRoot: string;
let oeUri: string;
let clsUri: string;
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
  tempRoot = mkdtempSync(join(tmpdir(), "pike-scope-qualifier-"));
  writeFileSync(join(tempRoot, "oa.pike"), OA_SRC);
  writeFileSync(join(tempRoot, "ob.pike"), OB_SRC);
  writeFileSync(join(tempRoot, "oe.pike"), OE_SRC);
  writeFileSync(join(tempRoot, "cls.pike"), CLS_SRC);

  oeUri = pathToFileURL(join(tempRoot, "oe.pike")).href;
  clsUri = pathToFileURL(join(tempRoot, "cls.pike")).href;

  server = await createTestServer({ rootUri: pathToFileURL(tempRoot).href });
  server.openDoc(pathToFileURL(join(tempRoot, "oa.pike")).href, OA_SRC);
  server.openDoc(pathToFileURL(join(tempRoot, "ob.pike")).href, OB_SRC);
  server.openDoc(oeUri, OE_SRC);
  server.openDoc(clsUri, CLS_SRC);
});

afterAll(async () => {
  await server.teardown();
  rmSync(tempRoot, { recursive: true, force: true });
});

// `  return A::shared() + B::shared() + B::only_a() + A::only_a();`
//   column:        12          26          40          54
const A_SHARED = 12;
const B_SHARED = 26;
const B_ONLY_A = 40;
const A_ONLY_A = 54;

describe("a qualified :: resolves against the inherit it names", () => {
  test("the first inherit's member points at the first inherit", async () => {
    const def = await definitionAt(oeUri, 4, A_SHARED);
    expect(def).not.toBeNull();
    expect(def!.uri).toEndWith("oa.pike");
  });

  test("the second inherit's member points at the SECOND inherit", async () => {
    // Both files declare `shared`. Answering oa.pike here is a wrong answer:
    // the oracle prints 1 and 2 for these two calls.
    const def = await definitionAt(oeUri, 4, B_SHARED);
    expect(def).not.toBeNull();
    expect(def!.uri).toEndWith("ob.pike");
  });

  test("a member the named inherit does not have answers nothing", async () => {
    // `B::only_a` is `Undefined identifier B::only_a.` under Pike. Pointing at
    // oa.pike's `only_a` invents a resolution the language does not have.
    expect(await definitionAt(oeUri, 4, B_ONLY_A)).toBeNull();
  });

  test("a member the named inherit does have still answers", async () => {
    const def = await definitionAt(oeUri, 4, A_ONLY_A);
    expect(def).not.toBeNull();
    expect(def!.uri).toEndWith("oa.pike");
  });
});

describe("a qualified :: inside a class body", () => {
  test("resolves against the aliased inherit, not the first one", async () => {
    // `  int probe() { return B::shared(); }`
    const def = await definitionAt(clsUri, 5, 26);
    expect(def).not.toBeNull();
    expect(def!.uri).toEndWith("ob.pike");
  });
});
