#!/usr/bin/env bun
/**
 * LSP audit entry point.
 *
 *   cli.ts sweep  --workspace <corpus|roxen> --out <ledger.jsonl>
 *   cli.ts triage --ledger <ledger.jsonl> --out <findings.md>
 *
 * Never wired into CI: the Roxen sweep takes tens of minutes and the oracle
 * needs Docker. See docs/superpowers/specs/2026-07-30-full-lsp-feature-audit-design.md.
 */

import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Ledger, readLedger, type LedgerRecord } from "./ledger";
import { runSweep } from "./sweep";
import { classify } from "./oracle";
import { expectationChecker, expectationPositions } from "./expectations";
import { triage, renderFindings, renderGrouped, groupFindings } from "./triage";

const CORPUS_ROOT = resolve("corpus/files");
const ROXEN_ROOT = process.env.ROXEN_HOME ?? "/tank/projects/roxen-6.1";

function pikeFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      // Dot-directories are tooling scaffolding, not corpus content.
      // corpus/files/.integration-fixtures holds Pike written to be WRONG
      // (`int wrong = "not an int"`, a call to a missing member) so the VSCode
      // diagnostics test can go red. Sweeping it manufactures findings about
      // code that is supposed to be broken.
      if (entry.startsWith(".")) continue;
      const path = join(dir, entry);
      // A broken symlink (the corpus ships one deliberately) makes statSync
      // throw; skipping it keeps the walk from taking the whole sweep down.
      let isDirectory = false;
      try {
        isDirectory = statSync(path).isDirectory();
      } catch {
        continue;
      }
      if (isDirectory) walk(path);
      else if (/\.(pike|pmod)$/.test(entry)) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

/**
 * Read a `--name value` flag.
 *
 * `bun run audit:sweep -- --workspace corpus` leaves a bare `--` in argv on
 * some bun versions; it is skipped rather than mistaken for a flag value.
 */
function flag(name: string, fallback?: string): string {
  const argv = process.argv.filter((a) => a !== "--");
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  if (fallback !== undefined) return fallback;
  throw new Error(`missing required flag --${name}`);
}

async function sweepCommand(): Promise<void> {
  const which = flag("workspace");
  const root = which === "roxen" ? ROXEN_ROOT : CORPUS_ROOT;
  const files = pikeFiles(root);
  const ledger = new Ledger(flag("out"));
  console.error(`sweeping ${files.length} files under ${root}`);
  try {
    await runSweep({
      workspaceRoot: root,
      workspaceName: which === "roxen" ? "roxen-6.1" : "corpus",
      surface: which === "roxen" ? "roxen" : "server",
      files,
      ledger,
      // Tier 2 only on the corpus tier: Roxen's correct answers are unknown,
      // so there is nothing to check a result against. The positions must be
      // forced in too — documentSymbol alone reaches almost none of them.
      checker: which === "roxen" ? undefined : expectationChecker(),
      extraPositions: which === "roxen" ? undefined : expectationPositions(),
    });
  } finally {
    ledger.close();
  }
}

/** One line per status, so a sweep's shape is visible without re-reading the ledger. */
function statusCounts(records: LedgerRecord[]): string {
  const counts = new Map<string, number>();
  for (const record of records) {
    counts.set(record.status, (counts.get(record.status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${status}=${count}`)
    .join(" ");
}

function triageCommand(): void {
  const records = readLedger(flag("ledger"));
  const roxenRecords = records.filter((r) => r.workspace === "roxen-6.1");
  const suspicious = [...new Set(
    roxenRecords.filter((r) => r.status !== "ok").map((r) => r.file),
  )];
  const verdicts = suspicious.length > 0 ? classify(suspicious, ROXEN_ROOT) : new Map();

  const findings = triage(records, { verdicts, roxenWorkspace: "roxen-6.1" });
  const out = flag("out");
  writeFileSync(out, renderFindings(findings) + "\n");
  // The grouped table is what a human reads: on the corpus, 211 of 253
  // findings were one root cause, and at Roxen scale that cluster runs to
  // thousands of identical rows that bury everything else.
  const grouped = groupFindings(findings);
  writeFileSync(out.replace(/\.md$/, "") + "-grouped.md", renderGrouped(findings) + "\n");
  console.error(
    `${findings.length} findings (${grouped.length} distinct defects) from ${records.length} records`,
  );
  console.error(`records by status: ${statusCounts(records)}`);
  const bySeverity = new Map<string, number>();
  for (const finding of findings) {
    bySeverity.set(finding.severity, (bySeverity.get(finding.severity) ?? 0) + 1);
  }
  console.error(
    `findings by severity: ${[...bySeverity.entries()].map(([s, c]) => `${s}=${c}`).join(" ") || "none"}`,
  );
}

const command = process.argv[2];
if (command === "sweep") await sweepCommand();
else if (command === "triage") triageCommand();
else {
  console.error("usage: cli.ts sweep --workspace <corpus|roxen> --out <path>");
  console.error("       cli.ts triage --ledger <path> --out <path>");
  process.exit(2);
}
