/**
 * Regression: the type hierarchy answered with unrelated classes, and hid real
 * ones. Verified against the pike binary — `Program.inherits` is the oracle for
 * what actually inherits what.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";

interface Item {
  name: string;
  uri: string;
  selectionRange: { start: { line: number; character: number } };
}

// A same-file chain (Animal <- Dog <- GuideDog) plus a DECOY class of the same
// name in a file main.pike never mentions.
const MAIN = `class Animal {
  void speak() { }
}

class Dog {
  inherit Animal;
  void bark() { }
}

class GuideDog {
  inherit Dog;
  void guide() { }
}
`;
const DECOY = `class Animal {
  void unrelated() { }
}
`;

// Two direct subclasses of one base, in a single file.
const BASE = `class Base {
  void ping() { }
}
`;
const KIDS = `inherit "base.pike";
class Alpha {
  inherit Base;
  void a() { }
}

class Beta {
  inherit Base;
  void b() { }
}
`;

describe("type hierarchy", () => {
  let server: TestServer;
  let root: string;
  let mainUri: string;
  let baseUri: string;
  const mainLines = MAIN.split("\n");
  const baseLines = BASE.split("\n");

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-typehier-"));
    for (const [name, src] of [
      ["main.pike", MAIN], ["decoy.pike", DECOY],
      ["base.pike", BASE], ["kids.pike", KIDS],
    ] as const) {
      writeFileSync(join(root, name), src);
    }
    mainUri = pathToFileURL(join(root, "main.pike")).href;
    baseUri = pathToFileURL(join(root, "base.pike")).href;

    server = await createTestServer({ rootUri: pathToFileURL(root).href });
    const uris: string[] = [];
    for (const [name, src] of [
      ["main.pike", MAIN], ["decoy.pike", DECOY],
      ["base.pike", BASE], ["kids.pike", KIDS],
    ] as const) {
      const u = pathToFileURL(join(root, name)).href;
      server.openDoc(u, src);
      uris.push(u);
    }
    await waitForFileEntry(server, uris, 30000);
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function prepare(uri: string, lines: string[], name: string): Promise<Item[]> {
    const line = lines.findIndex(l => l.includes(`class ${name}`));
    expect(line, `class ${name}`).toBeGreaterThanOrEqual(0);
    return await server.client.sendRequest("textDocument/prepareTypeHierarchy", {
      textDocument: { uri },
      position: { line, character: lines[line].indexOf(name) + 1 },
    }) as Item[];
  }

  async function supertypes(item: Item): Promise<Item[]> {
    return (await server.client.sendRequest("typeHierarchy/supertypes", { item }) as Item[]) ?? [];
  }
  async function subtypes(item: Item): Promise<Item[]> {
    return (await server.client.sendRequest("typeHierarchy/subtypes", { item }) as Item[]) ?? [];
  }

  test("a class is not its own subtype", async () => {
    const [dog] = await prepare(mainUri, mainLines, "Dog");
    const subs = await subtypes(dog);
    expect(subs.map(s => s.name)).not.toContain("Dog");
  });

  test("a supertype is not reported as a subtype", async () => {
    const [guideDog] = await prepare(mainUri, mainLines, "GuideDog");
    const subs = await subtypes(guideDog);
    expect(subs.map(s => s.name)).not.toContain("Dog");
    expect(subs).toEqual([]);
  });

  test("the same-file chain resolves both ways", async () => {
    const [dog] = await prepare(mainUri, mainLines, "Dog");
    expect((await supertypes(dog)).map(s => s.name)).toEqual(["Animal"]);
    expect((await subtypes(dog)).map(s => s.name)).toEqual(["GuideDog"]);
  });

  test("a same-named class in an unrelated file is not a supertype", async () => {
    const [dog] = await prepare(mainUri, mainLines, "Dog");
    const sups = await supertypes(dog);
    // Exactly one parent per inherit clause, and not the decoy.
    expect(sups).toHaveLength(1);
    expect(sups[0].uri).toBe(mainUri);
    expect(sups.some(s => s.uri.endsWith("decoy.pike"))).toBe(false);
  });

  test("every subclass in a file is reported, not just the first", async () => {
    const [base] = await prepare(baseUri, baseLines, "Base");
    const names = (await subtypes(base)).map(s => s.name).sort();
    expect(names).toEqual(["Alpha", "Beta"]);
  });
});
