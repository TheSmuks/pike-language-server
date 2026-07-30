import { test, expect } from "bun:test";
import { triage, renderFindings } from "../../tools/lsp-audit/triage";
import type { LedgerRecord } from "../../tools/lsp-audit/ledger";

const base: LedgerRecord = {
  surface: "server",
  workspace: "corpus",
  capability: "textDocument/hover",
  file: "a.pike",
  position: { line: 1, character: 2 },
  status: "ok",
  durationMs: 10,
  rssBytes: 0,
  digest: "object:1",
};

test("a crash is tier 0 and Critical", () => {
  const findings = triage([{ ...base, status: "error", detail: "boom" }]);
  expect(findings[0].tier).toBe(0);
  expect(findings[0].severity).toBe("Critical");
});

test("a timeout is tier 0 and Critical", () => {
  expect(triage([{ ...base, status: "timeout" }])[0].severity).toBe("Critical");
});

test("an empty result is tier 1 and High", () => {
  const findings = triage([{ ...base, status: "empty" }]);
  expect(findings[0].tier).toBe(1);
  expect(findings[0].severity).toBe("High");
});

test("a slow but successful request is tier 3 and Low", () => {
  const findings = triage([{ ...base, durationMs: 4000 }], { slowMs: 1000 });
  expect(findings[0].tier).toBe(3);
  expect(findings[0].severity).toBe("Low");
});

test("a healthy fast result produces no finding", () => {
  expect(triage([base])).toHaveLength(0);
});

test("a Roxen finding on invalid source is discarded", () => {
  const record = { ...base, workspace: "roxen-6.1", status: "empty" as const, file: "bad.pike" };
  const verdicts = new Map([["bad.pike", { file: "bad.pike", verdict: "syntax" as const }]]);
  expect(triage([record], { verdicts, roxenWorkspace: "roxen-6.1" })).toHaveLength(0);
});

test("a Roxen finding on valid source is kept and carries its verdict", () => {
  const record = { ...base, workspace: "roxen-6.1", status: "empty" as const, file: "good.pike" };
  const verdicts = new Map([["good.pike", { file: "good.pike", verdict: "ok" as const }]]);
  const findings = triage([record], { verdicts, roxenWorkspace: "roxen-6.1" });
  expect(findings).toHaveLength(1);
  expect(findings[0].oracleVerdict).toBe("ok");
});

test("every finding carries a hand-runnable reproduction", () => {
  const findings = triage([{ ...base, status: "empty" }]);
  expect(findings[0].reproduction).toContain("lsp-probe.ts");
  expect(findings[0].reproduction).toContain("2:3"); // 1-based, as lsp-probe takes
});

test("findings render as a markdown table with an id column", () => {
  const markdown = renderFindings(triage([{ ...base, status: "empty" }]));
  expect(markdown).toContain("| # |");
  expect(markdown).toContain("A1");
});

test("a wrong answer is tier 2 and Medium", () => {
  const findings = triage([{ ...base, status: "wrong", digest: "array:1" }]);
  expect(findings[0].tier).toBe(2);
  expect(findings[0].severity).toBe("Medium");
});

test("an unavailable oracle yields a surfaced, unclassified finding", () => {
  const record = { ...base, workspace: "roxen-6.1", status: "empty" as const, file: "x.pike" };
  const findings = triage([record], { verdicts: new Map(), roxenWorkspace: "roxen-6.1" });
  expect(findings).toHaveLength(1);
  expect(findings[0].oracleVerdict).toBe("unavailable");
});
