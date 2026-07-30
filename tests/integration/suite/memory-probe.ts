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

/** How many stdlib files to open. Enough to be realistic, bounded for runtime. */
const FILE_COUNT = 40;

/** Seconds to idle before reading the settled figure. */
const SETTLE_SECONDS = 65;

interface Sample {
  label: string;
  hostRssMb: number;
  hostHeapMb: number;
  hostExternalMb: number;
  serverRssMb: number | null;
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

/**
 * RSS of the language-server child, in MB.
 *
 * Matched by parent pid, not by cmdline. Matching on a name is wrong here: the
 * checkout directory is itself called `pike-language-server`, so every process
 * whose command line mentions the repo path — xvfb, VSCode itself, the probe
 * launcher — matches, and the first hit was a 3MB shell. The server is forked
 * by the extension host, so PPid equals this process's pid, which is exact.
 */
function serverRssMb(): number | null {
  const self = process.pid;
  let best: number | null = null;
  try {
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      let status: string;
      try { status = readFileSync(`/proc/${pid}/status`, "utf-8"); } catch { continue; }
      const ppid = /^PPid:\s+(\d+)$/m.exec(status);
      if (!ppid || Number(ppid[1]) !== self) continue;
      const rss = /^VmRSS:\s+(\d+) kB$/m.exec(status);
      if (!rss) continue;
      const mbValue = Math.round(Number(rss[1]) / 1024);
      // The host also forks the Pike worker; report the largest child, which is
      // the Node server, and note both if they ever converge.
      if (best === null || mbValue > best) best = mbValue;
    }
  } catch { /* not Linux, or /proc unreadable */ }
  return best;
}

function sample(label: string): Sample {
  const usage = process.memoryUsage();
  return {
    label,
    hostRssMb: mb(usage.rss),
    hostHeapMb: mb(usage.heapUsed),
    hostExternalMb: mb(usage.external + usage.arrayBuffers),
    serverRssMb: serverRssMb(),
  };
}

function report(samples: Sample[]): void {
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log("");
  console.log("=== Extension-host memory probe ===");
  console.log(`${pad("stage", 26)}${pad("host rss", 10)}${pad("host heap", 11)}${pad("host ext", 10)}server rss`);
  for (const s of samples) {
    console.log(
      pad(s.label, 26) +
      pad(`${s.hostRssMb}MB`, 10) +
      pad(`${s.hostHeapMb}MB`, 11) +
      pad(`${s.hostExternalMb}MB`, 10) +
      (s.serverRssMb === null ? "n/a" : `${s.serverRssMb}MB`),
    );
  }
  const first = samples[0];
  const peak = samples.reduce((a, b) => (b.hostRssMb > a.hostRssMb ? b : a));
  const last = samples[samples.length - 1];
  console.log("");
  console.log(`host growth (baseline -> settled): ${last.hostRssMb - first.hostRssMb}MB rss, ${last.hostHeapMb - first.hostHeapMb}MB heap`);
  console.log(`host peak: ${peak.hostRssMb}MB at "${peak.label}"`);
  if (first.serverRssMb !== null && last.serverRssMb !== null) {
    console.log(`server growth: ${last.serverRssMb - first.serverRssMb}MB rss`);
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
