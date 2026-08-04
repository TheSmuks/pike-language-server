/**
 * Regression: `inherit "file.pike";` and `inherit some_module;` inherit the
 * PROGRAM compiled from that file, not a class inside it.
 *
 * `findFirstClassOrSynthesize` fell back to the first class declaration in the
 * target file, which is arbitrary. Roxen's `inherit "module";` jumped to
 * `class ModuleJSONLogger`, 48 lines into module.pike; `inherit
 * cross_lib_module;` jumped to `class Calculator`, one of four unrelated
 * top-level symbols that module declares. Neither is what the inherit names.
 *
 * The file's own top is the honest target — and is already what the resolver
 * returned when the target file declared no class at all.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface Location { uri: string; range: Range }

// Several classes, none of which is what an `inherit "lib.pike"` names. The
// first one is the decoy the old fallback returned.
const LIB_SRC = `// a comment
int module_level_value = 1;

class FirstDecoy {
  int a;
}

class SecondDecoy {
  int b;
}

string helper() { return "from lib"; }
`;

const APP_SRC = `inherit "lib.pike";

int main() {
  write("%s\\n", helper());
  return 0;
}
`;

const CHILD_SRC = `inherit "lib.pike";

class Child {
  inherit FirstDecoy;
}
`;

describe("inherit resolves to the program, not an arbitrary inner class", () => {
  let server: TestServer;
  let root: string;
  let appUri: string;
  let libUri: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-inherit-target-"));
    writeFileSync(join(root, "lib.pike"), LIB_SRC);
    const app = join(root, "app.pike");
    writeFileSync(app, APP_SRC);
    appUri = pathToFileURL(app).href;
    libUri = pathToFileURL(join(root, "lib.pike")).href;

    server = await createTestServer({ rootUri: pathToFileURL(root).href });
    server.openDoc(appUri, APP_SRC);
    server.openDoc(libUri, LIB_SRC);
    await waitForFileEntry(server, [appUri, libUri], 60000);
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function defineAt(line: number, character: number): Promise<Location | null> {
    const res = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri: appUri }, position: { line, character },
    }) as Location | Location[] | null;
    return Array.isArray(res) ? res[0] ?? null : res;
  }

  test("a string-literal inherit targets the inherited file", async () => {
    // `inherit "lib.pike";` on line 0.
    const target = await defineAt(0, 12);
    expect(target, "the inherit must resolve somewhere").not.toBeNull();
    expect(target!.uri).toBe(libUri);
  });

  test("it targets the top of the file, not a class inside it", async () => {
    const target = await defineAt(0, 12);
    expect(target!.range.start.line,
      `expected the top of lib.pike, got line ${target!.range.start.line} ` +
      `(${LIB_SRC.split("\n")[target!.range.start.line] ?? "<past end>"})`).toBe(0);
  });

  test("it does not land on either decoy class", async () => {
    const target = await defineAt(0, 12);
    const line = LIB_SRC.split("\n")[target!.range.start.line] ?? "";
    expect(line).not.toContain("class FirstDecoy");
    expect(line).not.toContain("class SecondDecoy");
  });

  test("a class inherits a cross-file class without a no-op definition", async () => {
    const child = join(root, "child.pike");
    const childUri = pathToFileURL(child).href;
    writeFileSync(child, CHILD_SRC);
    server.openDoc(childUri, CHILD_SRC);
    await waitForFileEntry(server, [childUri], 60000);
    const res = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri: childUri }, position: { line: 3, character: 11 },
    }) as Location | Location[] | null;
    const target = Array.isArray(res) ? res[0] ?? null : res;

    expect(target?.uri).toBe(libUri);
    expect(target?.range.start.line).toBe(3);
  });
});
