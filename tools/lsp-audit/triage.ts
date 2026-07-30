/**
 * Triage: a pure function from ledger records to findings.
 *
 * Severity comes from the assertion tier, never from judgement, so two runs of
 * the same ledger produce the same list. Because triage reads a persisted
 * ledger, re-triaging with different thresholds never requires re-sweeping.
 */

import type { LedgerRecord, Tier } from "./ledger";
import { isOurDefect, type OracleResult, type Verdict } from "./oracle";

export type Severity = "Critical" | "High" | "Medium" | "Low";

export interface Finding {
  id: string;
  severity: Severity;
  tier: Tier;
  surface: string;
  capability: string;
  file: string;
  position: { line: number; character: number } | null;
  summary: string;
  reproduction: string;
  oracleVerdict?: Verdict;
}

export interface TriageOptions {
  slowMs?: number;
  verdicts?: Map<string, OracleResult>;
  /** Workspace label whose findings need an oracle verdict. */
  roxenWorkspace?: string;
}

const SEVERITY_BY_TIER: Record<Tier, Severity> = {
  0: "Critical",
  1: "High",
  2: "Medium",
  3: "Low",
};

/** lsp-probe takes 1-based line:col; the ledger stores 0-based LSP positions. */
function reproductionFor(record: LedgerRecord): string {
  const subcommand = probeSubcommand(record.capability);
  const target = `${record.workspace === "corpus" ? "corpus/files/" : ""}${record.file}`;
  if (!record.position) {
    return `bun run scripts/lsp-probe.ts ${subcommand} ${target}`;
  }
  const line = record.position.line + 1;
  const character = record.position.character + 1;
  return `bun run scripts/lsp-probe.ts ${subcommand} ${target} ${line}:${character}`;
}

/** Map an LSP method to the lsp-probe subcommand that reproduces it. */
function probeSubcommand(method: string): string {
  switch (method) {
    case "textDocument/hover": return "hover";
    case "textDocument/completion": return "complete";
    case "textDocument/definition": return "define";
    case "textDocument/documentSymbol": return "symbols";
    case "textDocument/semanticTokens/full": return "tokens";
    default: return `raw ${method}`;
  }
}

function tierOf(record: LedgerRecord, slowMs: number): Tier | null {
  if (record.status === "error" || record.status === "timeout") return 0;
  if (record.status === "empty") return 1;
  if (record.status === "wrong") return 2;
  if (record.durationMs > slowMs) return 3;
  return null;
}

function summaryOf(record: LedgerRecord, tier: Tier): string {
  switch (tier) {
    case 0:
      return `${record.capability} failed: ${record.detail ?? record.status}`;
    case 1:
      return `${record.capability} returned no result where one is required`;
    case 2:
      return `${record.capability} returned an incorrect result (${record.digest})`;
    case 3:
      return `${record.capability} took ${record.durationMs}ms`;
  }
}

export function triage(records: LedgerRecord[], options: TriageOptions = {}): Finding[] {
  const slowMs = options.slowMs ?? 1000;
  const findings: Finding[] = [];

  for (const record of records) {
    const tier = tierOf(record, slowMs);
    if (tier === null) continue;

    let verdict: Verdict | undefined;
    if (options.roxenWorkspace && record.workspace === options.roxenWorkspace) {
      verdict = options.verdicts?.get(record.file)?.verdict ?? "unavailable";
      // Pike rejects the source too, or could not read it — not our defect.
      // "unavailable" is kept and surfaced, so a missing oracle shows up as an
      // unclassified finding rather than silently vanishing.
      if (!isOurDefect(verdict) && verdict !== "unavailable") continue;
    }

    findings.push({
      id: `A${findings.length + 1}`,
      severity: SEVERITY_BY_TIER[tier],
      tier,
      surface: record.surface,
      capability: record.capability,
      file: record.file,
      position: record.position,
      summary: summaryOf(record, tier),
      reproduction: reproductionFor(record),
      oracleVerdict: verdict,
    });
  }

  const order: Severity[] = ["Critical", "High", "Medium", "Low"];
  return findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
}

export function renderFindings(findings: Finding[]): string {
  const rows = findings.map((f) => {
    const where = f.position ? `${f.file}:${f.position.line + 1}` : f.file;
    const verdict = f.oracleVerdict ? ` (oracle: ${f.oracleVerdict})` : "";
    return `| ${f.id} | ${f.severity[0]} | ${f.summary}${verdict} | \`${where}\` | \`${f.reproduction}\` |`;
  });
  return [
    "| # | Severity | Finding | Location | Reproduction |",
    "|---|----------|---------|----------|--------------|",
    ...rows,
  ].join("\n");
}
