/**
 * Extension-host memory probe.
 *
 * Answers one question the ordinary suite cannot: how much memory does *the
 * extension host* hold because of this extension, as distinct from the language
 * server it spawns? Those are separate processes, and VSCode's process explorer
 * lists the server as a child of the host, so it is easy to attribute the
 * server's RSS to the host and chase the wrong thing.
 *
 * Measured from inside the host, so `process.memoryUsage()` is the host's own.
 * The server is found by scanning for the child running `server.mjs` and read
 * from /proc, so both numbers come from the same instant.
 *
 * Methodology follows the project's recorded baseline practice: open Pike's own
 * stdlib largest-first (synthetic small files hide the pathology), and report
 * peak AND settled separately, because burst RSS is a transient high-water mark
 * that V8 returns within about 30s.
 *
 *   bun run memory:probe
 */
/// <reference types="vscode" />

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

/**
 * How many stdlib files to open. Enough to be realistic, bounded for runtime.
 * PIKE_PROBE_FILES overrides — a real session has far more open than 40.
 */
const FILE_COUNT = Number(process.env.PIKE_PROBE_FILES ?? "40");

/** Seconds to idle before reading the settled figure. */
const SETTLE_SECONDS = 65;

interface Sample {
  label: string;
  hostRssMb: number;
  hostHeapMb: number;
  hostExternalMb: number;
  serverRssMb: number | null;
  workerRssMb: number | null;
  treeTotalMb: number;
}

const mb = (bytes: number): number => Math.round(bytes / 1024 / 1024);

/** Pike's own stdlib module directory, via `pike --show-paths`. */
function stdlibDir(): string | null {
  try {
    // Pike writes --show-paths to stderr, not stdout, so read both — the same
    // reason pikeDetection.ts concatenates the two streams.
    const out = execFileSync(
      process.env.PIKE_BINARY || "pike",
      ["--show-paths"],
      { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] },
    );
    const err = (() => {
      try {
        return execFileSync(
          `${process.env.PIKE_BINARY || "pike"} --show-paths 2>&1 1>/dev/null`,
          { encoding: "utf-8", timeout: 5000, shell: "/bin/sh" } as never,
        ) as unknown as string;
      } catch { return ""; }
    })();
    // Pike pads each label with dots to a fixed column, so the dot count varies
    // with the label's length — match one or more, never a literal `...`.
    const match = /^Module path\.+\s*:\s*(.+)$/m.exec(`${out}\n${err}`);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/** The largest `.pike`/`.pmod` files under `dir`, biggest first. */
function largestSources(dir: string, limit: number): string[] {
  const found: { file: string; size: number }[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.name.endsWith(".pike") && !entry.name.endsWith(".pmod")) continue;
      try { found.push({ file: full, size: statSync(full).size }); } catch { /* skip */ }
    }
  };
  walk(dir, 0);
  found.sort((a, b) => b.size - a.size);
  return found.slice(0, limit).map((f) => f.file);
}

interface ProcInfo { pid: number; ppid: number; rssMb: number; pssMb: number; name: string }

/** Every process on the machine, with pid/ppid/RSS and a short name. */
function readAllProcs(): ProcInfo[] {
  const procs: ProcInfo[] = [];
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return procs; }
  for (const pid of entries) {
    if (!/^\d+$/.test(pid)) continue;
    let status: string;
    try { status = readFileSync(`/proc/${pid}/status`, "utf-8"); } catch { continue; }
    const ppid = /^PPid:\s+(\d+)$/m.exec(status);
    const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
    if (!ppid || !rss) continue;
    // PSS, not RSS, for the tree total. Electron runs a dozen processes that
    // share one large binary, and every one of them counts those pages in full
    // under RSS — summing it overstates the real footprint badly. PSS divides
    // each shared page by the number of processes mapping it, so the sum is
    // meaningful. Falls back to RSS where smaps_rollup is unreadable.
    let pssKb = Number(rss[1]);
    try {
      const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf-8");
      const pss = /^Pss:\s+(\d+) kB$/m.exec(rollup);
      if (pss) pssKb = Number(pss[1]);
    } catch { /* keep RSS */ }
    let cmdline = "";
    try { cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ").trim(); } catch { /* gone */ }
    procs.push({
      pid: Number(pid),
      ppid: Number(ppid[1]),
      rssMb: Math.round(Number(rss[1]) / 1024),
      pssMb: Math.round(pssKb / 1024),
      name: describeProc(cmdline),
    });
  }
  return procs;
}

/** Collapse a command line to something readable in a table. */
function describeProc(cmdline: string): string {
  if (!cmdline) return "(unknown)";
  if (cmdline.includes("worker.pike")) return "pike worker";
  if (cmdline.includes("server.mjs")) return "pike language server";
  if (cmdline.includes("--type=renderer")) return "vscode renderer";
  if (cmdline.includes("--type=gpu-process")) return "vscode gpu";
  if (cmdline.includes("--type=utility")) return "vscode utility";
  if (cmdline.includes("--type=zygote")) return "vscode zygote";
  if (cmdline.includes("extensionHost")) return "extension host";
  if (cmdline.includes("ptyHost")) return "vscode pty host";
  if (cmdline.includes("fileWatcher")) return "vscode file watcher";
  const first = cmdline.split(" ")[0];
  return first.split("/").pop() || first;
}

/**
 * Every process in the VSCode tree this host belongs to, with RSS.
 *
 * Walks up from this process to the topmost ancestor that is still part of the
 * tree, then collects all its descendants — so the Pike worker, which is a
 * grandchild via the language server, is included. An earlier version only
 * looked at direct children of the host and missed it entirely.
 */
function treeProcs(): { procs: ProcInfo[]; totalMb: number } {
  const all = readAllProcs();
  const byPid = new Map(all.map((p) => [p.pid, p]));

  let root = process.pid;
  for (let i = 0; i < 12; i++) {
    const parent = byPid.get(root)?.ppid;
    if (!parent || parent <= 1) break;
    const parentInfo = byPid.get(parent);
    // Stop before escaping into the shell/CI that launched VSCode.
    if (!parentInfo || /^(bash|sh|node|xvfb-run|Xvfb|npm|bun)$/.test(parentInfo.name)) break;
    root = parent;
  }

  const children = new Map<number, ProcInfo[]>();
  for (const p of all) {
    const list = children.get(p.ppid) ?? [];
    list.push(p);
    children.set(p.ppid, list);
  }

  const collected: ProcInfo[] = [];
  const stack = [root];
  while (stack.length > 0 && collected.length < 200) {
    const pid = stack.pop()!;
    const info = byPid.get(pid);
    if (info) collected.push(info);
    for (const child of children.get(pid) ?? []) stack.push(child.pid);
  }
  collected.sort((a, b) => b.pssMb - a.pssMb);
  return { procs: collected, totalMb: collected.reduce((sum, p) => sum + p.pssMb, 0) };
}

/** RSS of the language server, wherever it sits in the tree. */
function serverRssMb(): number | null {
  const found = treeProcs().procs.find((p) => p.name === "pike language server");
  return found ? found.rssMb : null;
}

/** RSS of the Pike worker subprocess, a grandchild via the server. */
function workerRssMb(): number | null {
  const found = treeProcs().procs.find((p) => p.name === "pike worker");
  return found ? found.rssMb : null;
}

function sample(label: string): Sample {
  const usage = process.memoryUsage();
  const tree = treeProcs();
  return {
    label,
    hostRssMb: mb(usage.rss),
    hostHeapMb: mb(usage.heapUsed),
    hostExternalMb: mb(usage.external + usage.arrayBuffers),
    serverRssMb: tree.procs.find((p) => p.name === "pike language server")?.rssMb ?? null,
    workerRssMb: tree.procs.find((p) => p.name === "pike worker")?.rssMb ?? null,
    treeTotalMb: tree.totalMb,
  };
}

function report(samples: Sample[]): void {
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log("");
  console.log("=== Extension-host memory probe ===");
  console.log(`${pad("stage", 24)}${pad("host", 9)}${pad("heap", 8)}${pad("server", 9)}${pad("worker", 9)}tree PSS`);
  for (const s of samples) {
    console.log(
      pad(s.label, 24) +
      pad(`${s.hostRssMb}MB`, 9) +
      pad(`${s.hostHeapMb}MB`, 8) +
      pad(s.serverRssMb === null ? "n/a" : `${s.serverRssMb}MB`, 9) +
      pad(s.workerRssMb === null ? "n/a" : `${s.workerRssMb}MB`, 9) +
      `${s.treeTotalMb}MB`,
    );
  }
  const first = samples[0];
  const peak = samples.reduce((a, b) => (b.hostRssMb > a.hostRssMb ? b : a));
  const last = samples[samples.length - 1];
  console.log("");
  console.log(`host growth (baseline -> settled): ${last.hostRssMb - first.hostRssMb}MB rss, ${last.hostHeapMb - first.hostHeapMb}MB heap`);
  console.log(`host peak: ${peak.hostRssMb}MB at "${peak.label}"`);
  const treePeak = samples.reduce((a, b) => (b.treeTotalMb > a.treeTotalMb ? b : a));
  console.log(`whole VSCode tree (PSS): ${last.treeTotalMb}MB settled, peak ${treePeak.treeTotalMb}MB at "${treePeak.label}"`);
  console.log("");
  console.log("--- per-process at settle (PSS, descending; RSS in brackets) ---");
  for (const p of treeProcs().procs.filter((p) => p.pssMb >= 5)) {
    console.log(`${pad(`${p.pssMb}MB`, 9)}${pad(`[rss ${p.rssMb}MB]`, 14)}${p.name}`);
  }
  console.log("");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function probe(): Promise<void> {
  const ext = vscode.extensions.all.find((e) => e.id.includes("pike-language-server"));
  if (!ext) throw new Error("Pike extension not found in the host");

  const samples: Sample[] = [];
  // Control: the host before our extension has run any code. Everything above
  // this line is VSCode's own floor, and attributing it to us would be wrong.
  samples.push(sample("host before activate"));

  if (!ext.isActive) await ext.activate();
  samples.push(sample("after activate"));

  const dir = stdlibDir();
  if (!dir) throw new Error("could not locate Pike's stdlib via `pike --show-paths`");
  const files = largestSources(dir, FILE_COUNT);
  console.log(`opening ${files.length} stdlib files from ${dir}, largest first`);

  for (let i = 0; i < files.length; i++) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(files[i]));
    await vscode.window.showTextDocument(doc, { preview: true });
    // Exercise the providers an editing session would: these are what make the
    // host hold token arrays, symbols and diagnostics.
    await vscode.commands.executeCommand("vscode.executeDocumentSymbolProvider", doc.uri);
    // Semantic tokens are the largest payload the host holds per document, and
    // they are OFF by default in this extension, so forcing them here overstates
    // an ordinary session. PIKE_PROBE_NO_TOKENS=1 measures the default path.
    if (!process.env.PIKE_PROBE_NO_TOKENS) {
      await vscode.commands.executeCommand("_provideDocumentSemanticTokens", doc.uri);
    }
    if ((i + 1) % 10 === 0) samples.push(sample(`after ${i + 1} files`));
  }

  samples.push(sample("all files open"));

  console.log(`idling ${SETTLE_SECONDS}s for the settled figure...`);
  await sleep(SETTLE_SECONDS * 1000);
  samples.push(sample("settled"));

  report(samples);
}
