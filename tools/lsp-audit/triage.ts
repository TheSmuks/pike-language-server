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

/**
 * lsp-probe subcommands that take a 1-BASED `line:col` argument.
 *
 * Everything else goes through `raw`, whose third argument is JSON spread
 * straight into the LSP request — so those params are 0-BASED, unlike these.
 * Mixing the two conventions up silently produces a command that reproduces a
 * different position than the finding.
 */
const DEDICATED_SUBCOMMAND: Record<string, string> = {
  "textDocument/hover": "hover",
  "textDocument/completion": "complete",
  "textDocument/definition": "define",
  "textDocument/documentSymbol": "symbols",
  "textDocument/semanticTokens/full": "tokens",
};

/**
 * Params the matrix sends beyond textDocument/position, per method.
 *
 * Without these the reproduction fires a different request than the one that
 * produced the finding — `references` without its context, `rename` without a
 * newName — and may not reproduce it at all.
 */
const EXTRA_PARAMS: Record<string, Record<string, unknown>> = {
  "textDocument/references": { context: { includeDeclaration: true } },
  "textDocument/rename": { newName: "auditRenamedSymbol" },
  "textDocument/signatureHelp": { context: { triggerKind: 1, isRetrigger: false } },
  "textDocument/codeAction": { context: { diagnostics: [] } },
  "textDocument/formatting": { options: { tabSize: 2, insertSpaces: true } },
  "textDocument/rangeFormatting": { options: { tabSize: 2, insertSpaces: true } },
  "textDocument/onTypeFormatting": { ch: "}", options: { tabSize: 2, insertSpaces: true } },
};

/** Methods whose params require a range. A whole-file range stands in. */
const RANGE_METHODS = new Set([
  "textDocument/rangeFormatting",
  "textDocument/inlayHint",
  "textDocument/codeAction",
  "textDocument/semanticTokens/range",
]);

const WHOLE_FILE_RANGE = {
  start: { line: 0, character: 0 },
  end: { line: 100000, character: 0 },
};

/**
 * Build a command a human can paste into a shell to see the bad result.
 *
 * This is the audit's credibility mechanism: a finding that cannot be
 * reproduced outside the harness is a harness artifact, not a defect. So the
 * command must actually run — `raw <method> <file> 2:3` does not, because
 * lsp-probe JSON.parses that third argument.
 */
function reproductionFor(record: LedgerRecord): string {
  const target = `${record.workspace === "corpus" ? "corpus/files/" : ""}${record.file}`;
  const dedicated = DEDICATED_SUBCOMMAND[record.capability];

  if (dedicated) {
    if (!record.position) return `bun run scripts/lsp-probe.ts ${dedicated} ${target}`;
    // 1-based: lsp-probe's parsePosition converts these to LSP coordinates.
    const line = record.position.line + 1;
    const character = record.position.character + 1;
    return `bun run scripts/lsp-probe.ts ${dedicated} ${target} ${line}:${character}`;
  }

  // raw: these params are spread verbatim into the request, so 0-based.
  const params: Record<string, unknown> = { ...EXTRA_PARAMS[record.capability] };
  if (RANGE_METHODS.has(record.capability)) params.range = WHOLE_FILE_RANGE;
  if (record.position) {
    if (record.capability === "textDocument/selectionRange") {
      params.positions = [record.position];
    } else {
      params.position = record.position;
    }
  }
  const json = JSON.stringify(params);
  return `bun run scripts/lsp-probe.ts raw ${record.capability} ${target} '${json}'`;
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
      id: "", // Assigned after the sort, so ids track display order.
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
  findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  // Ids are assigned last so A1 is the most severe finding. A reader treats
  // "A1" as a locator and works down the table; ids that don't match the
  // displayed order send them to the wrong row.
  return findings.map((finding, index) => ({ ...finding, id: `A${index + 1}` }));
}

/**
 * Escape a value for a markdown table cell.
 *
 * Server error messages land in these cells verbatim, and Pike's type syntax
 * uses `|` for unions (`string|Stdio.File`), so an unescaped detail string
 * silently breaks the row's columns. Newlines break the table outright.
 */
function cell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function renderFindings(findings: Finding[]): string {
  const rows = findings.map((f) => {
    const where = f.position ? `${f.file}:${f.position.line + 1}` : f.file;
    const verdict = f.oracleVerdict ? ` (oracle: ${f.oracleVerdict})` : "";
    return `| ${f.id} | ${f.severity[0]} | ${cell(f.summary + verdict)} | \`${cell(where)}\` | \`${cell(f.reproduction)}\` |`;
  });
  return [
    "| # | Severity | Finding | Location | Reproduction |",
    "|---|----------|---------|----------|--------------|",
    ...rows,
  ].join("\n");
}
