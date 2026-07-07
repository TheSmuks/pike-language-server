/**
 * Benchmark: lazy (stub) vs eager cache restore.
 *
 * Generates a synthetic cache of N files with non-trivial symbol tables, then
 * measures — in a fresh child process per mode, for clean RSS — the time and
 * resident memory to restore it:
 *   - eager: loadCache() + deserialize every symbol table + upsertCachedFile
 *            (the previous startup behavior)
 *   - lazy:  loadManifest() + restoreStubs() (the new behavior)
 *
 * Usage:
 *   bun --expose-gc scripts/bench-cache-restore.ts run [N]
 *   bun --expose-gc scripts/bench-cache-restore.ts <generate|eager|lazy> <dir> [N]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveCache, loadCache, deserializeSymbolTable } from "../server/src/features/persistentCache";
import { loadManifest, restoreStubs } from "../server/src/features/cacheManifest";
import { SymbolIndex } from "../server/src/features/symbolIndex";
import { hashContent } from "../server/src/features/cacheHash";
import { WorkspaceIndex } from "../server/src/features/workspaceIndex";
import type { SymbolTable, Declaration, Scope } from "../server/src/features/symbolTable";

const WASM = "bench-wasm";
const DECLS_PER_FILE = 30;

// Realistic scope shape: a handful of outline symbols (file-scope classes +
// class-scope methods) and many function-local variables (nested, not outline).
function makeTable(uri: string, index: number): SymbolTable {
  const declarations: Declaration[] = [];
  const push = (i: number, kind: Declaration["kind"], scopeId: number) => {
    const name = `Sym_${index}_${i}`;
    declarations.push({
      id: i, name, kind,
      nameRange: { start: { line: i, character: 0 }, end: { line: i, character: name.length } },
      range: { start: { line: i, character: 0 }, end: { line: i, character: 40 } },
      scopeId,
    });
  };
  let i = 0;
  for (let c = 0; c < 2; c++) push(i++, "class", 0);          // file-scope classes (outline)
  for (let m = 0; m < 8; m++) push(i++, "method", 1);         // class-scope methods (outline)
  for (; i < DECLS_PER_FILE; i++) push(i, "variable", 2);     // function-local vars (not outline)

  const span = (kind: Scope["kind"], id: number, parentId: number | null): Scope => ({
    id, kind, range: { start: { line: 0, character: 0 }, end: { line: DECLS_PER_FILE, character: 0 } },
    parentId, declarations: declarations.filter(d => d.scopeId === id).map(d => d.id), inheritedScopes: [],
  });
  const scopes: Scope[] = [span("file", 0, null), span("class", 1, 0), span("function", 2, 1)];
  return {
    uri, version: 1, declarations, references: [], scopes,
    declById: new Map(declarations.map(d => [d.id, d])),
    scopeById: new Map(scopes.map(s => [s.id, s])),
  };
}

async function generate(dir: string, n: number): Promise<void> {
  const index = new WorkspaceIndex({ workspaceRoot: dir });
  for (let i = 0; i < n; i++) {
    const uri = `file:///proj/file_${i}.pike`;
    await index.upsertCachedFile(uri, 1, makeTable(uri, i), hashContent(`content-${i}`));
  }
  await saveCache(dir, index, WASM);
}

function mem(): { heapUsedMb: number; rssMb: number } {
  const g = (globalThis as { gc?: () => void }).gc;
  if (g) { g(); g(); }
  const m = process.memoryUsage();
  return { heapUsedMb: m.heapUsed / 1048576, rssMb: m.rss / 1048576 };
}

async function eager(dir: string): Promise<void> {
  const index = new WorkspaceIndex({ workspaceRoot: dir });
  const t0 = performance.now();
  const cached = await loadCache(dir, WASM);
  let restored = 0;
  for (const e of cached ?? []) {
    if (!e.symbolTable) continue;
    const table = deserializeSymbolTable(e.symbolTable);
    const fe = index.upsertCachedFile(e.uri, e.version, table, e.contentHash);
    if (e.dependencies.length > 0) index.restoreDependencies(fe.uri, new Set(e.dependencies));
    restored++;
  }
  const ms = performance.now() - t0;
  const m = mem();
  report("eager", restored, ms, m);
}

async function lazy(dir: string): Promise<void> {
  const index = new WorkspaceIndex({ workspaceRoot: dir });
  const t0 = performance.now();
  let manifest = await loadManifest(dir, WASM);
  const restored = manifest ? restoreStubs(index, manifest) : 0;
  // Production path: build the resident index, then release the manifest parse
  // result so we measure steady-state, not the transient JSON.parse.
  index.symbolIndex = manifest ? new SymbolIndex(manifest) : null;
  manifest = null;
  const ms = performance.now() - t0;
  const m = mem();
  report("lazy", restored, ms, m);
}

async function symindex(dir: string): Promise<void> {
  const t0 = performance.now();
  let manifest = await loadManifest(dir, WASM);
  const files = manifest?.length ?? 0;
  const idx = manifest ? new SymbolIndex(manifest) : null;
  const symbols = idx ? idx.size : 0;
  manifest = null; // release the manifest parse result — measure the index alone
  const ms = performance.now() - t0;
  const m = mem();
  process.stdout.write(JSON.stringify({
    mode: "symindex", files, symbols,
    restoreMs: +ms.toFixed(1), heapUsedMb: +m.heapUsedMb.toFixed(1), rssMb: +m.rssMb.toFixed(1),
  }) + "\n");
}

function report(mode: string, files: number, ms: number, m: { heapUsedMb: number; rssMb: number }): void {
  process.stdout.write(JSON.stringify({
    mode, files, restoreMs: +ms.toFixed(1),
    heapUsedMb: +m.heapUsedMb.toFixed(1), rssMb: +m.rssMb.toFixed(1),
  }) + "\n");
}

async function main(): Promise<void> {
  const [cmd, arg1, arg2] = process.argv.slice(2);

  if (cmd === "generate") { await generate(arg1, Number(arg2 || 3000)); return; }
  if (cmd === "eager") { await eager(arg1); return; }
  if (cmd === "lazy") { await lazy(arg1); return; }
  if (cmd === "symindex") { await symindex(arg1); return; }

  if (cmd === "run") {
    const n = Number(arg1 || 3000);
    const dir = mkdtempSync(join(tmpdir(), "pike-lsp-bench-"));
    const env = { ...process.env, XDG_CACHE_HOME: dir };
    try {
      // Generate the cache in its own process so it does not skew RSS.
      const gen = Bun.spawnSync(["bun", "--expose-gc", import.meta.path, "generate", dir, String(n)], { env });
      if (gen.exitCode !== 0) { process.stderr.write(gen.stderr.toString()); return; }

      const results: Record<string, unknown>[] = [];
      for (const mode of ["eager", "lazy", "symindex"]) {
        const r = Bun.spawnSync(["bun", "--expose-gc", import.meta.path, mode, dir], { env });
        if (r.exitCode !== 0) { process.stderr.write(r.stderr.toString()); return; }
        results.push(JSON.parse(r.stdout.toString().trim()));
      }
      printComparison(n, results);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    return;
  }

  process.stderr.write("usage: bench-cache-restore.ts run [N]\n");
  process.exit(1);
}

function printComparison(n: number, results: Record<string, unknown>[]): void {
  const e = results.find(r => r.mode === "eager")!;
  const l = results.find(r => r.mode === "lazy")!;
  const pct = (a: number, b: number) => `${(((a - b) / a) * 100).toFixed(0)}% less`;
  process.stdout.write(`\nCache restore benchmark — ${n} files, ${DECLS_PER_FILE} decls each\n`);
  process.stdout.write(`${"mode".padEnd(8)}${"files".padEnd(8)}${"restoreMs".padEnd(12)}${"heapUsedMb".padEnd(12)}rssMb\n`);
  for (const r of results) {
    process.stdout.write(
      `${String(r.mode).padEnd(8)}${String(r.files).padEnd(8)}${String(r.restoreMs).padEnd(12)}${String(r.heapUsedMb).padEnd(12)}${r.rssMb}\n`,
    );
  }
  process.stdout.write(`\nlazy vs eager: time ${pct(e.restoreMs as number, l.restoreMs as number)}, `);
  process.stdout.write(`heap ${pct(e.heapUsedMb as number, l.heapUsedMb as number)}, rss ${pct(e.rssMb as number, l.rssMb as number)}\n`);
}

await main();
