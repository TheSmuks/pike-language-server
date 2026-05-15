/**
 * Tests for Pike's directory module convention:
 * files inside Foo.pmod/ automatically see symbols from Foo.pmod/module.pmod.
 *
 * @goal Verify that hover, definition, and completion resolve symbols from
 * an implicit module.pmod without explicit inherit/import.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

// Create a temp directory module structure:
//   TestDir/
//     TestModule.pmod/
//       module.pmod    — defines helper() and HelperClass
//       consumer.pike  — uses helper() and HelperClass
let tempRoot: string;
let moduleDir: string;
let modulePmodUri: string;
let consumerPikeUri: string;

const MODULE_PMOD_SRC = `
string helper(string s) {
  return "hello " + s;
}

class HelperClass {
  string name;
  void create(string n) {
    name = n;
  }
  string greet() {
    return "hi " + name;
  }
}
`;

const CONSUMER_PIKE_SRC = `
int main() {
  string msg = helper("world");
  HelperClass hc = HelperClass("test");
  write("%s %s\\n", msg, hc->greet());
  return 0;
}
`;

describe("directory module.pmod implicit resolution", () => {
  let server: TestServer;

  beforeAll(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "pike-lsp-modtest-"));
    moduleDir = join(tempRoot, "TestModule.pmod");
    mkdirSync(moduleDir, { recursive: true });
    writeFileSync(join(moduleDir, "module.pmod"), MODULE_PMOD_SRC);
    writeFileSync(join(moduleDir, "consumer.pike"), CONSUMER_PIKE_SRC);

    modulePmodUri = pathToFileURL(join(moduleDir, "module.pmod")).href;
    consumerPikeUri = pathToFileURL(join(moduleDir, "consumer.pike")).href;

    server = await createTestServer({ rootUri: pathToFileURL(tempRoot).href });
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("hover on helper() call resolves to module.pmod", async () => {
    server.openDoc(modulePmodUri, MODULE_PMOD_SRC);
    server.openDoc(consumerPikeUri, CONSUMER_PIKE_SRC);

    // Wait for indexing
    await new Promise(r => setTimeout(r, 200));

    // helper("world") — "helper" starts at line 2, char 18
    const result = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri: consumerPikeUri },
      position: { line: 2, character: 18 },
    }) as { contents?: { value?: string } } | null;

    expect(result).not.toBeNull();
    expect(result!.contents?.value).toContain("helper");
  });

  test("hover on HelperClass resolves to module.pmod", async () => {
    // HelperClass at line 3, char 2
    const result = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri: consumerPikeUri },
      position: { line: 3, character: 2 },
    }) as { contents?: { value?: string } } | null;

    expect(result).not.toBeNull();
    expect(result!.contents?.value).toContain("HelperClass");
  });

  test("go-to-definition on helper() resolves to module.pmod", async () => {
    const result = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri: consumerPikeUri },
      position: { line: 2, character: 18 },
    }) as { uri?: string } | null;

    expect(result).not.toBeNull();
    // The definition should point to module.pmod
    expect(result!.uri).toContain("module.pmod");
  });
});
