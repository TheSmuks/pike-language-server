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
import { createTestServer, type TestServer } from "./helpers";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

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
