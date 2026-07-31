/**
 * Two families of plain identifier that no index could reach.
 *
 * **Compiler-defined constants.** `UNDEFINED`, `__FILE__`, `__LINE__` and the
 * rest are defined by the Pike compiler, not declared in any Pike source, so
 * the autodoc-derived builtin index has never carried them. `UNDEFINED` occurs
 * 170 times in Roxen 6.1 and `__FILE__` 58. The set was taken from the
 * compiler: each one compiles and prints under Pike 8.0.1116, and `__NT__` —
 * which Roxen writes 96 times — is deliberately excluded because it does not
 * (`Undefined identifier __NT__.`, it exists only on Windows).
 *
 * **A module installed as a C module.** `Image` ships as `Image.so`, with no
 * `.pmod` directory for the file-based resolver to find, so it hovered as
 * nothing at 272 positions while `Stdio` and `ADT` — which ship as
 * directories — answered. The runtime resolver knew it all along but was
 * gated on the path containing a dot, which a bare head never does.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, waitForIndexed, type TestServer } from "./helpers";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { parse } from "../../server/src/parser";
import { buildSymbolTable, type Declaration } from "../../server/src/features/symbolTable";

const SRC = `int main()
{
  mixed u = UNDEFINED;
  write("%s:%d %s\\n", __FILE__, __LINE__, __DIR__);
  object img = Image.Image(1, 1);
  object q = ADT.Queue();
  int nt = __NT__;
  return sizeof(u) + sizeof(img) + sizeof(q) + nt;
}
`;

interface HoverResult { contents: { value: string } }

let tempRoot: string;
let uri: string;
let server: TestServer;

async function hoverAt(line: number, character: number): Promise<HoverResult | null> {
  return await server.client.sendRequest("textDocument/hover", {
    textDocument: { uri }, position: { line, character },
  }) as HoverResult | null;
}

/** Column of `name` on the given source line. */
function col(line: number, name: string): number {
  return SRC.split("\n")[line].indexOf(name);
}

beforeAll(async () => {
  tempRoot = mkdtempSync(join(tmpdir(), "pike-plain-ident-"));
  writeFileSync(join(tempRoot, "m.pike"), SRC);
  uri = pathToFileURL(join(tempRoot, "m.pike")).href;
  server = await createTestServer({ rootUri: pathToFileURL(tempRoot).href });
  server.openDoc(uri, SRC);
});

afterAll(async () => {
  await server.teardown();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("constants the compiler defines", () => {
  for (const [line, name, expected] of [
    [2, "UNDEFINED", "undefined value"],
    [3, "__FILE__", "file being compiled"],
    [3, "__LINE__", "Line number"],
    [3, "__DIR__", "Directory"],
  ] as const) {
    test(`${name} is described`, async () => {
      const hover = await hoverAt(line, col(line, name));
      expect(hover, name).not.toBeNull();
      expect(hover!.contents.value).toContain(name);
      expect(hover!.contents.value).toContain(expected);
    });
  }

  test("a constant the compiler does NOT define stays unanswered", async () => {
    // `__NT__` is Windows-only; on this platform Pike rejects it outright, so
    // describing it would be inventing a symbol.
    expect(await hoverAt(6, col(6, "__NT__"))).toBeNull();
  });
});

describe("a module installed as a C module", () => {
  test("Image answers even though it has no .pmod on disk", async () => {
    const hover = await hoverAt(4, col(4, "Image"));
    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("Image");
  });

  test("a directory module still answers", async () => {
    const hover = await hoverAt(5, col(5, "ADT"));
    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("ADT");
  });
});

/**
 * A getter/setter pair is one property, and it is a Pike feature — not a Roxen
 * one, so it must work in anybody's code.
 *
 * Pike 8.0.1116: with `int \`v()` and `void \`v=(int x){_v = x*2;}` on class R,
 * `class Sub { inherit R; int bump(){ v = 5; return v; } }` prints 10 — so `v`
 * is genuinely the member's name, readable and writable and inherited. The
 * server recorded it under the declared spelling, where `v` matched nothing:
 * not bare in a subclass, not as `obj->v`.
 */
describe("a getter/setter pair is one property", () => {
  const BASE = `class Request {
  mapping misc = ([]);
  Config \`conf() { return 0; }
  void \`conf=(Config c) { }
}
class Config { string name = "cfg"; }
`;
  const USER = `inherit "FwBase";

class MyRequest {
  inherit Request;
  Config which() { return conf; }
}

int handle(Request id) { return sizeof(id->conf); }
`;

  let dir: string;
  let s: TestServer;
  let u: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pike-property-"));
    writeFileSync(join(dir, "FwBase.pike"), BASE);
    writeFileSync(join(dir, "mymod.pike"), USER);
    u = pathToFileURL(join(dir, "mymod.pike")).href;
    s = await createTestServer({ rootUri: pathToFileURL(dir).href });
    const baseUri = pathToFileURL(join(dir, "FwBase.pike")).href;
    s.openDoc(baseUri, BASE);
    s.openDoc(u, USER);
    // `conf` is declared in FwBase.pike and read from mymod.pike, so the answer
    // exists only once the index holds both.
    await waitForIndexed(s, [baseUri, u]);
  });

  afterAll(async () => {
    await s.teardown();
    rmSync(dir, { recursive: true, force: true });
  });

  async function hov(line: number, character: number) {
    return await s.client.sendRequest("textDocument/hover", {
      textDocument: { uri: u }, position: { line, character },
    }) as HoverResult | null;
  }

  test("the property is declared once, not once per accessor", () => {
    // The getter and the setter are two declarations of ONE member; recording
    // both put `conf` in the scope twice, so every lookup had to pick.
    const table = buildSymbolTable(
      parse(BASE), "file:///FwBase.pike", 1, undefined, BASE,
    );
    const conf = table.declarations.filter((d: Declaration) => d.name === "conf");
    expect(conf.length).toBe(1);
    // And under the name readers write, never the declared spelling.
    expect(table.declarations.some((d: Declaration) => d.name.startsWith("`"))).toBe(false);
  });

  test("a bare read in a subclass resolves", async () => {
    // `  Config which() { return conf; }`
    const line = 4;
    const hover = await hov(line, USER.split("\n")[line].indexOf("conf"));
    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("conf");
  });

  test("a read through a typed receiver resolves", async () => {
    // `int handle(Request id) { return sizeof(id->conf); }`
    const line = 7;
    const hover = await hov(line, USER.split("\n")[line].indexOf("id->conf") + 4);
    expect(hover).not.toBeNull();
    expect(hover!.contents.value).toContain("conf");
  });
});

describe("completion offers the compiler's constants", () => {
  test("__FILE__ and UNDEFINED are suggested", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pike-magic-complete-"));
    const src = "int main() {\n  mixed x = __\n  return 0;\n}\n";
    writeFileSync(join(dir, "c.pike"), src);
    const u2 = pathToFileURL(join(dir, "c.pike")).href;
    const s2 = await createTestServer({ rootUri: pathToFileURL(dir).href });
    try {
      s2.openDoc(u2, src);
      const result = await s2.client.sendRequest("textDocument/completion", {
        textDocument: { uri: u2 }, position: { line: 1, character: 14 },
      }) as { items: Array<{ label: string }> } | null;
      const labels = (result?.items ?? []).map(i => i.label);
      for (const name of ["__FILE__", "__LINE__", "__DIR__", "UNDEFINED"]) {
        expect(labels, name).toContain(name);
      }
      // Not offered as a call: they take no arguments.
      const file = (result?.items ?? []).find(i => i.label === "__FILE__") as
        { insertText?: string } | undefined;
      expect(file?.insertText).toBeUndefined();
    } finally {
      await s2.teardown();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
