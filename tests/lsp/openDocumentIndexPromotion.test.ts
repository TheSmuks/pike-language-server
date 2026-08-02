/**
 * An open document must keep a live symbol table in the workspace index.
 *
 * Regression guard for the dependency-closure invalidation defect: opening a
 * file whose `inherit`/`import`/`#include` target exists on disk but is not yet
 * indexed made `indexDependencyClosure` index the target and then call
 * `rewireDependents(target)`, which dropped the *opened* file's symbol table so
 * inheritance wiring would re-run. Nothing re-ran it — the lazy rebuild only
 * fires on a query that goes through `getOrIndexSymbolTable`. The entry for the
 * file the user is looking at therefore sat `stale: true` with a null symbol
 * table for the rest of the session.
 *
 * These tests need a real on-disk `rootUri`: with the synthetic in-memory
 * workspaces most LSP tests use, the dependency cannot be read from disk, the
 * closure indexes nothing, and the bug does not reproduce.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForIndexed, type TestServer } from "./helpers";

function makeWorkspace(prefix: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text, "utf8");
  }
  return dir;
}

const LEAF = 'inherit "base.pike";\n\nvoid leafOnlyMember() { }\n';

interface SymbolInformation { name: string; location: { uri: string } }

let server: TestServer;
let root: string;
let leafUri: string;

beforeAll(async () => {
  root = makeWorkspace("pike-open-doc-index-", {
    "base.pike": "void baseMember(string path) { }\n",
    "leaf.pike": LEAF,
  });
  server = await createTestServer({ rootUri: pathToFileURL(root).href });
  leafUri = pathToFileURL(join(root, "leaf.pike")).href;
});

afterAll(async () => {
  await server.teardown();
});

describe("workspace index after opening a file with an on-disk dependency", () => {
  test("the opened file's entry is promoted, not left stale", async () => {
    // An unsaved-only declaration proves the index holds the buffer, not the
    // file on disk.
    server.openDoc(leafUri, LEAF + "\nvoid unsavedOnlyMember() { }\n");

    await waitForIndexed(server, [leafUri]);

    expect(server.server.index.isStale(leafUri)).toBe(false);
    const table = server.server.index.getSymbolTable(leafUri);
    expect(table).not.toBeNull();
    expect(table!.declarations.map((d) => d.name)).toContain("unsavedOnlyMember");
  });

  test("workspace/symbol finds the opened file's symbols", async () => {
    // Self-sufficient: opening is idempotent, and asserting the precondition
    // keeps a failure here from being read as a workspace/symbol bug when it is
    // really the document never having been indexed.
    server.openDoc(leafUri, LEAF + "\nvoid unsavedOnlyMember() { }\n");
    await waitForIndexed(server, [leafUri]);
    expect(server.server.index.getSymbolTable(leafUri)).not.toBeNull();

    // No hover or go-to-definition first: those recover the entry on demand and
    // would mask the defect. workspace/symbol reads the index directly.
    const results = await server.client.sendRequest("workspace/symbol", {
      query: "leafOnlyMember",
    }) as SymbolInformation[];

    expect(results.some((r) => r.name === "leafOnlyMember" && r.location.uri === leafUri))
      .toBe(true);
  });

  // The repair is an open-time operation. If it ever leaked onto the change
  // path, every keystroke in a base class would rebuild every open subclass —
  // the cost the stale-mark plus lazy-rebuild design exists to avoid. Counting
  // upserts is the only way to see that: the index state after a keystroke
  // looks the same either way.
  test("a keystroke re-indexes only the edited document", async () => {
    const dir = makeWorkspace("pike-keystroke-", {
      "base.pike": "void baseMember() { }\n",
      "sub.pike": 'inherit "base.pike";\nvoid subMember() { }\n',
    });
    const editServer = await createTestServer({ rootUri: pathToFileURL(dir).href });
    const uri = (name: string) => pathToFileURL(join(dir, name)).href;

    editServer.openDoc(uri("sub.pike"), 'inherit "base.pike";\nvoid subMember() { }\n');
    editServer.openDoc(uri("base.pike"), "void baseMember() { }\n");
    await waitForIndexed(editServer, [uri("base.pike"), uri("sub.pike")]);

    const index = editServer.server.index as unknown as {
      upsertFile: (...args: unknown[]) => Promise<unknown>;
    };
    const realUpsert = index.upsertFile.bind(index);
    let upserts = 0;
    index.upsertFile = (...args: unknown[]) => { upserts++; return realUpsert(...args); };

    try {
      editServer.client.sendNotification("textDocument/didChange", {
        textDocument: { uri: uri("base.pike"), version: 99 },
        contentChanges: [{ text: "void baseMember() { }\nvoid addedMember() { }\n" }],
      });
      // Long enough to cover the repair's coalescing delay, had it run.
      await new Promise((r) => setTimeout(r, 600));
      expect(upserts).toBe(1);
    } finally {
      index.upsertFile = realUpsert;
      await editServer.teardown();
    }
  });
});

describe("workspace index after opening a whole inherit chain at once", () => {
  // Repairing a base class re-invalidates the subclass, so the repair has to
  // run dependencies-first or the subclass is left stale again. This is the
  // case an editor produces when it restores several tabs on startup.
  test("every open document in the chain keeps a symbol table", async () => {
    const dir = makeWorkspace("pike-open-chain-", {
      "a.pike": "void aMember() { }\n",
      "b.pike": 'inherit "a.pike";\nvoid bMember() { }\n',
      "c.pike": 'inherit "b.pike";\nvoid cMember() { }\n',
    });
    const chainServer = await createTestServer({ rootUri: pathToFileURL(dir).href });
    const uri = (name: string) => pathToFileURL(join(dir, name)).href;

    // Opened in the same tick, subclass first — the order that lost the race.
    chainServer.openDoc(uri("c.pike"), 'inherit "b.pike";\nvoid cMember() { }\n');
    chainServer.openDoc(uri("b.pike"), 'inherit "a.pike";\nvoid bMember() { }\n');

    try {
      await waitForIndexed(chainServer, [uri("b.pike"), uri("c.pike")]);
      expect(chainServer.server.index.isStale(uri("b.pike"))).toBe(false);
      expect(chainServer.server.index.isStale(uri("c.pike"))).toBe(false);
    } finally {
      await chainServer.teardown();
    }
  });

  // No dependency order exists inside a cycle: repairing either member empties
  // the other, so a dependency-ordered pass alone can never settle one. Mutual
  // inherits are real in Roxen, so this must resolve rather than exhaust the
  // repair's budget and warn.
  test("a mutual-inherit cycle settles with both entries populated", async () => {
    const dir = makeWorkspace("pike-open-cycle-", {
      "a.pike": 'inherit "b.pike";\nvoid aMember() { }\n',
      "b.pike": 'inherit "a.pike";\nvoid bMember() { }\n',
    });
    const cycleServer = await createTestServer({ rootUri: pathToFileURL(dir).href });
    const uri = (name: string) => pathToFileURL(join(dir, name)).href;

    cycleServer.openDoc(uri("a.pike"), 'inherit "b.pike";\nvoid aMember() { }\n');
    cycleServer.openDoc(uri("b.pike"), 'inherit "a.pike";\nvoid bMember() { }\n');

    try {
      await waitForIndexed(cycleServer, [uri("a.pike"), uri("b.pike")]);
      expect(cycleServer.server.index.isStale(uri("a.pike"))).toBe(false);
      expect(cycleServer.server.index.isStale(uri("b.pike"))).toBe(false);

      // Both must be visible to a consumer that reads the index directly.
      const results = await cycleServer.client.sendRequest("workspace/symbol", {
        query: "",
      }) as SymbolInformation[];
      const names = results.map((r) => r.name);
      expect(names).toContain("aMember");
      expect(names).toContain("bMember");
    } finally {
      await cycleServer.teardown();
    }
  });
});
