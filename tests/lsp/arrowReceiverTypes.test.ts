/**
 * `receiver->member` answers from the receiver's type, or not at all.
 *
 * Two halves, both settled against Pike 8.0.1116.
 *
 * **A container or primitive receiver names no declaration.** Verified one at
 * a time: `mapping m; m->foo` is `m["foo"]` and prints `0`; `multiset ms;
 * ms->a` is a membership test and prints `1`; `string s; s->size` and `float f;
 * f->foo` do not compile (`Indexing on illegal type.`); `int i; i->foo` fails
 * at run time. The cross-file fallback searches the inherit chain by bare NAME
 * with no knowledge of the receiver, so `pkt->ip` on a mapping came back
 * pointing at an `ip` in `Stdio.pmod` — 1,747 such answers across Roxen 6.1.
 *
 * **`array` is the exception and must keep answering.** `array(Obj) as;
 * as->twice()` automaps and returns one result per element, so an array of a
 * class does have members. Suppressing it would trade a wrong answer for a
 * missing one.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// `shared` is declared in a file the consumer inherits, so the bare-name
// fallback has something to find — which is exactly what must not happen for
// the memberless receivers.
const BASE_SRC = `int shared() { return 1; }
`;

const MAIN_SRC = `inherit "abase";

class Obj { int shared() { return 9; } }

int probe(mapping m, multiset ms, string s, int i, float f,
          array(Obj) as, Obj o)
{
  return m->shared + ms->shared + s->shared + i->shared + f->shared
       + sizeof(as->shared()) + o->shared();
}
`;

interface DefinitionResult { uri: string; range: { start: { line: number } } }

let tempRoot: string;
let mainUri: string;
let server: TestServer;

async function definitionAt(line: number, character: number): Promise<DefinitionResult | null> {
  const result = await server.client.sendRequest("textDocument/definition", {
    textDocument: { uri: mainUri },
    position: { line, character },
  });
  if (!result) return null;
  return (Array.isArray(result) ? result[0] : result) as DefinitionResult;
}

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "pike-arrow-recv-"));
  writeFileSync(join(tempRoot, "abase.pike"), BASE_SRC);
  writeFileSync(join(tempRoot, "main.pike"), MAIN_SRC);

  mainUri = pathToFileURL(join(tempRoot, "main.pike")).href;
  server = await createTestServer({ rootUri: pathToFileURL(tempRoot).href });
  server.openDoc(pathToFileURL(join(tempRoot, "abase.pike")).href, BASE_SRC);
  server.openDoc(mainUri, MAIN_SRC);
});

afterAll(async () => {
  await server.teardown();
  rmSync(tempRoot, { recursive: true, force: true });
});

// `  return m->shared + ms->shared + s->shared + i->shared + f->shared`
const LINE = 7;
// `       + sizeof(as->shared()) + o->shared();`
const AUTOMAP_LINE = 8;
const MEMBERLESS: Array<[string, number]> = [
  ["mapping", MAIN_SRC.split("\n")[LINE].indexOf("m->shared") + 3],
  ["multiset", MAIN_SRC.split("\n")[LINE].indexOf("ms->shared") + 4],
  ["string", MAIN_SRC.split("\n")[LINE].indexOf("s->shared +") + 3],
  ["int", MAIN_SRC.split("\n")[LINE].indexOf("i->shared") + 3],
  ["float", MAIN_SRC.split("\n")[LINE].indexOf("f->shared") + 3],
];

describe("a container or primitive receiver names no declaration", () => {
  for (const [label, column] of MEMBERLESS) {
    test(`${label} receiver answers nothing`, async () => {
      expect(await definitionAt(LINE, column)).toBeNull();
    });
  }
});

describe("receivers that do have members still answer", () => {
  test("an array of a class automaps to the element's member", async () => {
    // `       + sizeof(as->shared()) + o->shared();`
    const line = AUTOMAP_LINE;
    const column = MAIN_SRC.split("\n")[line].indexOf("as->shared") + 4;
    const def = await definitionAt(line, column);
    expect(def).not.toBeNull();
    expect(def!.uri).toEndWith("main.pike");
  });

  test("a class-typed receiver resolves to that class's member", async () => {
    const line = AUTOMAP_LINE;
    const column = MAIN_SRC.split("\n")[line].indexOf("o->shared") + 3;
    const def = await definitionAt(line, column);
    expect(def).not.toBeNull();
    expect(def!.uri).toEndWith("main.pike");
    // `Obj::shared`, not the inherited `abase::shared` of the same name.
    expect(def!.range.start.line).toBe(2);
  });
});

/**
 * A dotted path names a module, and its member belongs to that module.
 *
 * `Image.PNG.encode` is `encode` of `Image.PNG`. When the path cannot be
 * resolved the answer is nothing — not whichever `encode` the bare-name search
 * turns up in the inherit chain. Roxen's `configuration.pike` had three of
 * these (`ADT.Table.ASCII.encode`, `Image.JPEG.encode`, `Image.PNG.encode`)
 * all answering the same unrelated `encode` in `Variable.pmod`.
 */
describe("a dotted module path binds its member", () => {
  test("an unresolvable path does not fall back to a same-named symbol", async () => {
    // `abase.pike` declares `shared`, and main.pike inherits it — so the
    // bare-name search has an answer available and must not give it.
    const src = 'inherit "abase";\nint probe() { return Nonexistent.Thing.shared(); }\n';
    const dir = mkdtempSync(join(tmpdir(), "pike-dot-path-"));
    writeFileSync(join(dir, "abase.pike"), BASE_SRC);
    writeFileSync(join(dir, "m.pike"), src);
    const uri = pathToFileURL(join(dir, "m.pike")).href;

    const s = await createTestServer({ rootUri: pathToFileURL(dir).href });
    try {
      s.openDoc(pathToFileURL(join(dir, "abase.pike")).href, BASE_SRC);
      s.openDoc(uri, src);
      const result = await s.client.sendRequest("textDocument/definition", {
        textDocument: { uri },
        position: { line: 1, character: src.split("\n")[1].indexOf("shared") },
      });
      expect(result).toBeNull();
    } finally {
      await s.teardown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
