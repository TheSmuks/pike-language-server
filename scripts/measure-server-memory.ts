#!/usr/bin/env bun
/**
 * Measure a language-server build's memory against Pike's own stdlib.
 *
 * Drives the server directly over stdio — no VSCode — so two builds can be
 * compared with one variable: the server code. Reports peak and settled RSS
 * separately, because the burst is a transient high-water mark that V8 returns
 * within about 30s; reading "settled" sooner than 60s reports the burst.
 *
 *   bun run scripts/measure-server-memory.ts <server.mjs> [--files N] [--settle S]
 *
 * Also reports PSS. Summing RSS across processes double-counts shared pages,
 * and the difference is large enough to change conclusions.
 */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_FILES = 60;
const DEFAULT_SETTLE_S = 70;
/** Matches the VSCode client's cap: max(budget + 256, 1.5 × budget), budget 512. */
const HEAP_CAP_MB = 768;

interface Args { server: string; files: number; settleS: number }

function parseArgs(argv: string[]): Args {
  const server = argv.find((a) => !a.startsWith("--"));
  if (!server) {
    console.error("usage: measure-server-memory.ts <server.mjs> [--files N] [--settle S]");
    process.exit(2);
  }
  const num = (flag: string, fallback: number): number => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback;
  };
  return { server, files: num("--files", DEFAULT_FILES), settleS: num("--settle", DEFAULT_SETTLE_S) };
}

/** Pike's stdlib module directory. `--show-paths` writes to stderr. */
function stdlibDir(): string {
  const out = execFileSync("/bin/sh", ["-c", "pike --show-paths 2>&1"], { encoding: "utf-8", timeout: 5000 });
  const match = /^Module path\.+\s*:\s*(.+)$/m.exec(out);
  if (!match) throw new Error("could not read Pike's module path");
  return match[1].trim();
}

function largestSources(dir: string, limit: number): string[] {
  const found: { file: string; size: number }[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.name.endsWith(".pike") && !entry.name.endsWith(".pmod")) continue;
      try { found.push({ file: full, size: statSync(full).size }); } catch { /* skip */ }
    }
  };
  walk(dir, 0);
  found.sort((a, b) => b.size - a.size);
  return found.slice(0, limit).map((f) => f.file);
}

/** RSS and PSS of a pid and all its descendants, in MB. */
function memoryOf(rootPid: number): { rssMb: number; pssMb: number } {
  const procs: { pid: number; ppid: number; rssKb: number; pssKb: number }[] = [];
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let status: string;
    try { status = readFileSync(`/proc/${pid}/status`, "utf-8"); } catch { continue; }
    const ppid = /^PPid:\s+(\d+)$/m.exec(status);
    const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
    if (!ppid || !rss) continue;
    let pssKb = Number(rss[1]);
    try {
      const pss = /^Pss:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${pid}/smaps_rollup`, "utf-8"));
      if (pss) pssKb = Number(pss[1]);
    } catch { /* keep RSS */ }
    procs.push({ pid: Number(pid), ppid: Number(ppid[1]), rssKb: Number(rss[1]), pssKb });
  }
  let rssKb = 0;
  let pssKb = 0;
  const stack = [rootPid];
  const seen = new Set<number>();
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const self = procs.find((p) => p.pid === pid);
    if (self) { rssKb += self.rssKb; pssKb += self.pssKb; }
    for (const child of procs.filter((p) => p.ppid === pid)) stack.push(child.pid);
  }
  return { rssMb: Math.round(rssKb / 1024), pssMb: Math.round(pssKb / 1024) };
}

class Server {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, (v: unknown) => void>();

  constructor(serverPath: string) {
    this.child = spawn(process.execPath, [`--max-old-space-size=${HEAP_CAP_MB}`, "--expose-gc", serverPath, "--stdio"], {
      env: { ...process.env, PIKE_LSP_STDIO: "1" },
      stdio: "pipe",
    });
    this.child.stdout.on("data", (c: Buffer) => this.onData(c));
    this.child.stderr.on("data", () => { /* server logs; ignored */ });
  }

  get pid(): number { return this.child.pid!; }

  request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const p = new Promise<T>((resolve) => this.pending.set(id, (v) => resolve(v as T)));
    this.send({ jsonrpc: "2.0", id, method, params });
    return p;
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  stop(): void { this.child.kill(); }

  private send(msg: unknown): void {
    const body = Buffer.from(JSON.stringify(msg), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const len = /Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString("utf8"));
      if (!len) return;
      const start = headerEnd + 4;
      const end = start + Number(len[1]);
      if (this.buffer.length < end) return;
      const msg = JSON.parse(this.buffer.subarray(start, end).toString("utf8")) as { id?: number; result?: unknown };
      this.buffer = this.buffer.subarray(end);
      if (typeof msg.id === "number") {
        const resolve = this.pending.get(msg.id);
        if (resolve) { this.pending.delete(msg.id); resolve(msg.result); }
      }
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dir = stdlibDir();
  const files = largestSources(dir, args.files);
  console.log(`server:  ${args.server}`);
  console.log(`corpus:  ${files.length} largest files from ${dir}`);

  const server = new Server(args.server);
  await server.request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(dir).href,
    capabilities: {},
    workspaceFolders: [{ name: "stdlib", uri: pathToFileURL(dir).href }],
    initializationOptions: { diagnosticMode: "off" },
  });
  server.notify("initialized", {});
  await sleep(2000);

  let peak = memoryOf(server.pid);
  for (let i = 0; i < files.length; i++) {
    server.notify("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(files[i]!).href,
        languageId: "pike",
        version: 1,
        text: readFileSync(files[i]!).toString("latin1"),
      },
    });
    // Exercise the paths that build symbol tables.
    await server.request("textDocument/documentSymbol", { textDocument: { uri: pathToFileURL(files[i]!).href } });
    const now = memoryOf(server.pid);
    if (now.rssMb > peak.rssMb) peak = now;
  }

  const afterOpen = memoryOf(server.pid);
  console.log(`peak:    ${peak.rssMb}MB rss / ${peak.pssMb}MB pss`);
  console.log(`open:    ${afterOpen.rssMb}MB rss / ${afterOpen.pssMb}MB pss`);
  console.log(`idling ${args.settleS}s...`);
  await sleep(args.settleS * 1000);
  const settled = memoryOf(server.pid);
  console.log(`settled: ${settled.rssMb}MB rss / ${settled.pssMb}MB pss`);
  server.stop();
}

void main();
