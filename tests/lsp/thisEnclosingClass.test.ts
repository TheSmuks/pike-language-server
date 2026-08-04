/**
 * Regression: `this` / `this_object()` / `this_program` must bind to the class
 * that ENCLOSES them, not to the first class declared in the same scope.
 *
 * `findEnclosingClassDecl` located the enclosing class SCOPE correctly and then
 * walked the parent scope's declaration list returning the first entry of kind
 * `class`. Every class in a file is declared in that same parent scope, so in a
 * file with more than one class every `this` answered the FIRST one.
 *
 * The existing coverage could not see it: renameCorruption.test.ts asserts
 * go-to-definition on `this` lands on the class, but its fixture declares a
 * single class, where "first in scope" and "encloses me" are the same
 * declaration. The bug needs a second class to become visible.
 *
 * Found by tools/lsp-audit/wrong-target-sweep.ts against Roxen 6.1, where 371
 * of 461 `this`/`this_object()` sites answered the wrong class — e.g.
 * server/base_server/cache.pike:433 sits in `class CacheManager` (line 226) and
 * answered `class CacheEntry` (line 76).
 *
 * The expected answer is established with the pike binary below, not by
 * inspection: `this_object()` inside `Second` really is a `Second`.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";
import { pikeAvailable } from "../helpers/pikeAvailable";

/** Honour PIKE_BINARY the way the rest of the suite does. */
const PIKE = process.env.PIKE_BINARY ?? "pike";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface Location { uri: string; range: Range }

// Three classes so that "first in scope", "last in scope" and "encloses me" are
// three different answers, and a nested class so the innermost one has to win
// over its own enclosing class too.
const SRC = `class First {
  int id() { return 1; }
  object me() { return this_object(); }
}

class Second {
  int id() { return 2; }
  object me() { return this_object(); }
  object self() { return this; }
  string own() { return sprintf("%O", this_program); }

  class Inner {
    int id() { return 3; }
    object me() { return this_object(); }
  }
}

class Third {
  int id() { return 4; }
  object me() { return this_object(); }
}

int main() {
  write("second %d\\n", Second()->me()->id());
  write("inner %d\\n", Second()->Inner()->me()->id());
  write("third %d\\n", Third()->me()->id());
  write("self %d\\n", Second()->self()->id());
  return 0;
}
`;

describe("this / this_object() bind to the enclosing class", () => {
  let server: TestServer;
  let root: string;
  let uri: string;
  let file: string;
  const lines = SRC.split("\n");

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-this-enclosing-"));
    file = join(root, "enclosing.pike");
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

  /** Go to definition on the `name` occurrence on `line`, return the target line's text. */
  async function defineOn(name: string, line: number): Promise<string> {
    const col = lines[line].indexOf(name);
    expect(col, `${name} present on line ${line}`).toBeGreaterThanOrEqual(0);
    const res = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri }, position: { line, character: col + 2 },
    }) as Location | Location[] | null;
    const first = Array.isArray(res) ? res[0] : res;
    expect(first, `definition on ${name} at line ${line}`).not.toBeNull();
    return lines[first!.range.start.line];
  }

  test("this_object() in the first class answers that class", async () => {
    expect(await defineOn("this_object()", 2)).toContain("class First");
  });

  test("this_object() in a later class answers that class, not the first", async () => {
    expect(await defineOn("this_object()", 7)).toContain("class Second");
  });

  test("this in a later class answers that class, not the first", async () => {
    expect(await defineOn("this", 8)).toContain("class Second");
  });

  test("this_program in a later class answers that class, not the first", async () => {
    expect(await defineOn("this_program", 9)).toContain("class Second");
  });

  test("this_object() in a nested class answers the inner class", async () => {
    expect(await defineOn("this_object()", 13)).toContain("class Inner");
  });

  test("this_object() in the last class answers that class", async () => {
    expect(await defineOn("this_object()", 19)).toContain("class Third");
  });

  test.skipIf(!pikeAvailable)(
    "pike is the oracle: this_object() really is the enclosing class",
    () => {
      const out = execFileSync(PIKE, [file], { encoding: "utf8" });
      // If `this_object()` bound to the first class, Second()->me()->id() would
      // be 1 rather than 2 — pike says otherwise, so the server must agree.
      expect(out).toContain("second 2");
      expect(out).toContain("inner 3");
      expect(out).toContain("third 4");
      expect(out).toContain("self 2");
    },
  );
});
