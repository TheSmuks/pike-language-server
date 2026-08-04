/**
 * Regression: subtypes must be classes that inherit THIS class.
 *
 * `checkInheritDeclarationsForTarget` matched an inherit declaration on its
 * NAME alone — no file, no identity. Two files each declaring `class Animal`
 * and `class Dog : Animal` made every Dog a subtype of every Animal, so
 * navigating the hierarchy led into unrelated code. The sibling function that
 * walks resolved inherit scopes already had the file check; the by-name
 * fallback never did.
 *
 * The check used here is the dependency graph: unless the candidate is in the
 * target's own file, its file must actually depend on the target's. That keeps
 * genuine cross-file subtypes, which is why a bare same-file rule was not
 * enough.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface Item { name: string; uri: string; range: Range; selectionRange: Range }

// Two independent hierarchies that share every class name.
const ONE_SRC = `class Animal {
  string speak() { return "..."; }
}

class Dog {
  inherit Animal;
  string speak() { return "woof"; }
}
`;

const TWO_SRC = `class Animal {
  string speak() { return "???"; }
}

class Dog {
  inherit Animal;
  string speak() { return "bark"; }
}
`;

describe("subtypes are identified by inheritance, not by name", () => {
  let server: TestServer;
  let root: string;
  let oneUri: string;
  let twoUri: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-subtype-"));
    writeFileSync(join(root, "one.pike"), ONE_SRC);
    writeFileSync(join(root, "two.pike"), TWO_SRC);
    oneUri = pathToFileURL(join(root, "one.pike")).href;
    twoUri = pathToFileURL(join(root, "two.pike")).href;

    server = await createTestServer({ rootUri: pathToFileURL(root).href });
    server.openDoc(oneUri, ONE_SRC);
    server.openDoc(twoUri, TWO_SRC);
    await waitForFileEntry(server, [oneUri, twoUri], 60000);
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function subtypesOfAnimalIn(uri: string): Promise<Item[]> {
    // `class Animal` is line 0; its name starts at column 6.
    const items = await server.client.sendRequest("textDocument/prepareTypeHierarchy", {
      textDocument: { uri }, position: { line: 0, character: 6 },
    }) as Item[] | null;
    expect(items?.length, `prepareTypeHierarchy must find Animal in ${uri}`).toBeGreaterThan(0);
    return (await server.client.sendRequest("typeHierarchy/subtypes", {
      item: items![0],
    }) as Item[]) ?? [];
  }

  test("one.pike's Animal has exactly one subtype, in one.pike", async () => {
    const subs = await subtypesOfAnimalIn(oneUri);
    expect(subs.map(s => s.name)).toEqual(["Dog"]);
    expect(subs[0].uri, "the Dog from two.pike must not be listed").toBe(oneUri);
  });

  test("two.pike's Animal has exactly one subtype, in two.pike", async () => {
    const subs = await subtypesOfAnimalIn(twoUri);
    expect(subs.map(s => s.name)).toEqual(["Dog"]);
    expect(subs[0].uri, "the Dog from one.pike must not be listed").toBe(twoUri);
  });

  test("no subtype is reported from a file that does not depend on the target", async () => {
    for (const [uri, other] of [[oneUri, twoUri], [twoUri, oneUri]] as const) {
      const subs = await subtypesOfAnimalIn(uri);
      expect(subs.every(s => s.uri !== other),
        `a subtype from ${other} leaked into ${uri}'s hierarchy`).toBe(true);
    }
  });
});
