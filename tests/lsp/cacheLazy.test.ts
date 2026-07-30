/**
 * Lazy (stub) cache restore tests.
 *
 * Verifies the manifest → stub restore → on-demand hydration path:
 * startup restores dependency edges only (no symbol tables resident), and a
 * stub's table is hydrated from cache when the source is unchanged.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { saveCache, getCachePath } from "../../server/src/features/persistentCache";
import { loadManifest, restoreStubs } from "../../server/src/features/cacheManifest";
import { SymbolIndex } from "../../server/src/features/symbolIndex";
import { searchWorkspaceSymbols } from "../../server/src/features/workspaceSymbol";
import { hydrateFromCache } from "../../server/src/features/cacheHydrate";
import { hashContent } from "../../server/src/features/cacheHash";
import { WorkspaceIndex } from "../../server/src/features/workspaceIndex";
import type { SymbolTable, Declaration, Scope } from "../../server/src/features/symbolTable";

let tempDir: string;
let origCacheHome: string | undefined;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "pike-lsp-lazy-"));
  origCacheHome = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = tempDir;
});

afterAll(() => {
  if (origCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = origCacheHome;
  rmSync(tempDir, { recursive: true, force: true });
});

function makeTable(uri: string, names: string[]): SymbolTable {
  const declarations: Declaration[] = names.map((name, i) => ({
    id: i, name, kind: "class" as const,
    nameRange: { start: { line: 0, character: 0 }, end: { line: 0, character: name.length } },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
    scopeId: 0,
  }));
  const scopes: Scope[] = [{
    id: 0, kind: "file" as const,
    range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } },
    parentId: null, declarations: declarations.map(d => d.id), inheritedScopes: [],
  }];
  return {
    uri, version: 1, declarations, references: [], scopes,
    declById: new Map(declarations.map(d => [d.id, d])),
    scopeById: new Map(scopes.map(s => [s.id, s])),
  };
}

describe("Lazy (stub) cache restore", () => {
  test("manifest → stubs → hydrate roundtrip", async () => {
    const wasm = "lazy-wasm";
    const uri = "file:///proj/animal.pike";
    const source = "class Animal {}\n";
    const hash = hashContent(source);

    const saved = new WorkspaceIndex({ workspaceRoot: tempDir });
    await saved.upsertCachedFile(uri, 1, makeTable(uri, ["Animal", "Dog"]), hash);
    await saveCache(tempDir, saved, wasm);

    // Manifest lists the file without a symbol table.
    const manifest = await loadManifest(tempDir, wasm);
    expect(manifest).not.toBeNull();
    expect(manifest!.length).toBe(1);
    expect(manifest![0].uri).toBe(uri);
    expect(manifest![0].contentHash).toBe(hash);

    // Restore as a stub: entry present, but no resident symbol table.
    const fresh = new WorkspaceIndex({ workspaceRoot: tempDir });
    expect(restoreStubs(fresh, manifest!)).toBe(1);
    expect(fresh.getFile(uri)).toBeTruthy();
    expect(fresh.getSymbolTable(uri)).toBeNull();

    // Hydrate from cache with unchanged source → table becomes resident.
    expect(await hydrateFromCache(fresh, tempDir, uri, source)).toBe(true);
    const table = fresh.getSymbolTable(uri);
    expect(table).not.toBeNull();
    expect(table!.declarations[0].name).toBe("Animal");
  });

  test("hydration refuses a stale stub (source changed since cache)", async () => {
    const wasm = "lazy-wasm-2";
    const uri = "file:///proj/stale.pike";
    const source = "class Old {}\n";
    const hash = hashContent(source);

    const saved = new WorkspaceIndex({ workspaceRoot: tempDir });
    await saved.upsertCachedFile(uri, 1, makeTable(uri, ["Old"]), hash);
    await saveCache(tempDir, saved, wasm);

    const manifest = await loadManifest(tempDir, wasm);
    const fresh = new WorkspaceIndex({ workspaceRoot: tempDir });
    restoreStubs(fresh, manifest!);

    // Different content hashes differently → cache is stale → no hydration.
    expect(await hydrateFromCache(fresh, tempDir, uri, "class New {}\n")).toBe(false);
    expect(fresh.getSymbolTable(uri)).toBeNull();
  });

  // The path completion/cross-file features rely on: a sync getSymbolTable
  // returns null for a stub, but getOrIndexSymbolTable hydrates it on demand
  // via a cache-backed on-demand indexer (mirrors serverInitHandler.onDemandIndex).
  test("getOrIndexSymbolTable hydrates a stub via cache-backed on-demand", async () => {
    const wasm = "lazy-ondemand";
    const srcDir = mkdtempSync(join(tmpdir(), "pike-lsp-lazy-src-"));
    const filePath = join(srcDir, "widget.pike");
    const source = "class Widget {}\n";
    writeFileSync(filePath, source);
    const uri = pathToFileURL(filePath).href;

    const saved = new WorkspaceIndex({ workspaceRoot: tempDir });
    await saved.upsertCachedFile(uri, 1, makeTable(uri, ["Widget"]), hashContent(source));
    await saveCache(tempDir, saved, wasm);

    const manifest = await loadManifest(tempDir, wasm);
    const fresh = new WorkspaceIndex({ workspaceRoot: tempDir });
    restoreStubs(fresh, manifest!);
    fresh.setOnDemandIndexFn(async (u) => {
      const content = await readFile(fileURLToPath(u), "utf-8");
      if (await hydrateFromCache(fresh, tempDir, u, content)) return fresh.getFile(u) ?? null;
      return null;
    });

    // Sync access sees only the stub (null); the on-demand path hydrates it.
    expect(fresh.getSymbolTable(uri)).toBeNull();
    const table = await fresh.getOrIndexSymbolTable(uri);
    expect(table).not.toBeNull();
    expect(table!.declarations[0].name).toBe("Widget");

    rmSync(srcDir, { recursive: true, force: true });
  });

  // The modern-LSP win: workspace/symbol answers from the resident index for
  // never-opened (stub) files, with zero hydration.
  test("workspace symbol search finds stub-file symbols without hydration", async () => {
    const wasm = "lazy-wssym";
    const uriA = "file:///proj/a.pike";
    const uriB = "file:///proj/b.pike";

    const saved = new WorkspaceIndex({ workspaceRoot: tempDir });
    await saved.upsertCachedFile(uriA, 1, makeTable(uriA, ["Alpha"]), hashContent("class Alpha {}\n"));
    await saved.upsertCachedFile(uriB, 1, makeTable(uriB, ["Beta"]), hashContent("class Beta {}\n"));
    await saveCache(tempDir, saved, wasm);

    const manifest = await loadManifest(tempDir, wasm);
    const fresh = new WorkspaceIndex({ workspaceRoot: tempDir });
    restoreStubs(fresh, manifest!);
    fresh.symbolIndex = new SymbolIndex(manifest!);

    const hits = searchWorkspaceSymbols("Al", fresh);
    expect(hits.map(r => r.name)).toContain("Alpha");
    expect(fresh.getSymbolTable(uriA)).toBeNull(); // never hydrated

    const all = searchWorkspaceSymbols("", fresh).map(r => r.name).sort();
    expect(all).toEqual(["Alpha", "Beta"]);
  });

  // Guards the upgrade path the format bump exists for: a manifest saved by
  // an older build (byte-converted positions, or source decoded without
  // #charset awareness) must not be restored just because the wasm hash
  // still matches — loadManifest's formatVersion check is what gates that.
  test("loadManifest rejects a stale format version even with matching wasm hash", async () => {
    const wasm = "lazy-stale-format";
    // Own workspace root (not the shared tempDir) so the doctored cacheIndex
    // does not interfere with the other tests' shared cache location.
    const staleWorkspaceRoot = `${tempDir}-stale-format`;
    const uri = "file:///proj/stale-format.pike";

    const saved = new WorkspaceIndex({ workspaceRoot: staleWorkspaceRoot });
    await saved.upsertCachedFile(uri, 1, makeTable(uri, ["StaleFormat"]), hashContent("class StaleFormat {}\n"));
    await saveCache(staleWorkspaceRoot, saved, wasm);

    // Same wasm hash as we'll load with, but an older format version than
    // this build understands.
    const indexPath = join(getCachePath(staleWorkspaceRoot), "cacheIndex.json");
    writeFileSync(indexPath, JSON.stringify({ formatVersion: 1, wasmHash: wasm, entryCount: 1 }));

    const manifest = await loadManifest(staleWorkspaceRoot, wasm);
    expect(manifest).toBeNull();
  });
});
