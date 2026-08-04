/**
 * Regression: outgoing calls must resolve the callee the way navigation does.
 *
 * `resolveCallee` matched on a bare NAME — first any declaration in this file's
 * table, then the first match in the whole workspace index. With no receiver
 * type, no file and no scope in the comparison, `s->describe()` was answered
 * with a `describe` from an entirely unrelated file, and an override was
 * indistinguishable from the base method it overrides.
 *
 * The dedup key made it worse: it was the resolved callee, so a second, genuine
 * callsite that happened to resolve to the same (wrong) declaration was dropped
 * instead of being recorded as another `fromRange`.
 *
 * Go-to-definition already answers all of these correctly, so the fix is to ask
 * the same resolvers in the same order rather than to invent a name match.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";

interface Range { start: { line: number; character: number }; end: { line: number; character: number } }
interface Item { name: string; uri: string; range: Range; selectionRange: Range }
interface OutgoingCall { to: Item; fromRanges: Range[] }

const BASE_SRC = `class BaseShape {
  string colour;
  void create(string c) { colour = c; }
  string describe() { return "shape " + colour; }
  int area() { return 0; }
}
`;

// A same-named method in an unrelated file — the decoy the name match found.
const DECOY_SRC = `class Unrelated {
  string describe() { return "not this one"; }
  int area() { return -1; }
}
`;

const CHILD_SRC = `inherit "base.pike";

class Rectangle {
  inherit BaseShape;
  int w, h;
  void create(string c, int a, int b) { ::create(c); w = a; h = b; }
  int area() { return w * h; }
}
`;

const MAIN_SRC = `inherit "base.pike";
inherit "child.pike";

int main() {
  BaseShape s = BaseShape("red");
  write("%s\\n", s->describe());
  write("%d\\n", s->area());
  Rectangle r = Rectangle("blue", 3, 4);
  write("%d\\n", r->area());
  write("%s\\n", r->describe());
  return 0;
}
`;

describe("outgoing calls resolve by receiver, not by bare name", () => {
  let server: TestServer;
  let root: string;
  let mainUri: string;
  let calls: OutgoingCall[] = [];

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-callhier-"));
    writeFileSync(join(root, "base.pike"), BASE_SRC);
    writeFileSync(join(root, "decoy.pike"), DECOY_SRC);
    writeFileSync(join(root, "child.pike"), CHILD_SRC);
    const main = join(root, "main.pike");
    writeFileSync(main, MAIN_SRC);
    mainUri = pathToFileURL(main).href;

    server = await createTestServer({ rootUri: pathToFileURL(root).href });
    const uris: string[] = [];
    for (const [name, src] of [
      ["base.pike", BASE_SRC], ["decoy.pike", DECOY_SRC],
      ["child.pike", CHILD_SRC], ["main.pike", MAIN_SRC],
    ] as const) {
      const uri = pathToFileURL(join(root, name)).href;
      server.openDoc(uri, src);
      uris.push(uri);
    }
    await waitForFileEntry(server, uris, 60000);

    const items = await server.client.sendRequest("textDocument/prepareCallHierarchy", {
      textDocument: { uri: mainUri }, position: { line: 3, character: 5 },
    }) as Item[] | null;
    expect(items?.length, "prepareCallHierarchy must find main()").toBeGreaterThan(0);
    calls = await server.client.sendRequest("callHierarchy/outgoingCalls", {
      item: items![0],
    }) as OutgoingCall[];
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("no callee resolves into the unrelated decoy file", () => {
    const fromDecoy = calls.filter(c => c.to.uri.endsWith("decoy.pike"));
    expect(fromDecoy.map(c => c.to.name), "decoy.pike must never be a callee").toEqual([]);
  });

  test("every callsite in main() is accounted for", () => {
    // Four member calls plus the write()s; the member calls are what matter.
    const memberCallLines = calls
      .filter(c => c.to.name === "describe" || c.to.name === "area")
      .flatMap(c => c.fromRanges.map(r => r.start.line))
      .sort((a, b) => a - b);
    expect(memberCallLines, "all four member callsites must appear").toEqual([5, 6, 8, 9]);
  });

  test("the override is attributed to the child, not the base", () => {
    // r->area() on line 8 must reach Rectangle::area in child.pike.
    const override = calls.find(
      c => c.to.name === "area" && c.fromRanges.some(r => r.start.line === 8),
    );
    expect(override, "r->area() must resolve").toBeDefined();
    expect(override!.to.uri.endsWith("child.pike"),
      `expected child.pike, got ${override!.to.uri}`).toBe(true);
  });

  test("the base method is still attributed to the base", () => {
    // s->area() on line 6 must reach BaseShape::area in base.pike.
    const base = calls.find(
      c => c.to.name === "area" && c.fromRanges.some(r => r.start.line === 6),
    );
    expect(base, "s->area() must resolve").toBeDefined();
    expect(base!.to.uri.endsWith("base.pike"),
      `expected base.pike, got ${base!.to.uri}`).toBe(true);
  });

  test("repeated calls to one function group into a single entry", () => {
    const writes = calls.filter(c => c.to.name === "write");
    expect(writes.length, "write() must appear once, not once per callsite")
      .toBeLessThanOrEqual(1);
    if (writes.length === 1) {
      expect(writes[0].fromRanges.length, "all four write() callsites kept").toBe(4);
    }
  });
});
