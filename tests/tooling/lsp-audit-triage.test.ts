import { test, expect } from "bun:test";
import { triage, renderFindings, groupFindings, renderGrouped } from "../../tools/lsp-audit/triage";
import type { LedgerRecord } from "../../tools/lsp-audit/ledger";
import { MATRIX } from "../../tools/lsp-audit/matrix";

/** Methods lsp-probe has a dedicated subcommand for; the rest use `raw`. */
const DEDICATED_METHODS = new Set([
  "textDocument/hover",
  "textDocument/completion",
  "textDocument/definition",
  "textDocument/documentSymbol",
  "textDocument/semanticTokens/full",
]);

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

test("the raw-fallback reproduction is a runnable command, not a bare position", () => {
  // Every other test uses hover, which has a dedicated subcommand. That is why
  // the raw fallback shipped broken: `raw <method> <file> 2:3` makes lsp-probe
  // JSON.parse "2:3" and throw before sending anything.
  const finding = triage([{ ...base, capability: "textDocument/references", status: "empty" }])[0];
  expect(finding.reproduction).toContain("raw textDocument/references");
  // The third argument must be parseable JSON carrying 0-based LSP coordinates.
  const json = finding.reproduction.match(/'(\{.*\})'$/)?.[1];
  expect(json).toBeDefined();
  const params = JSON.parse(json!);
  expect(params.position).toEqual({ line: 1, character: 2 });
  expect(params.context).toEqual({ includeDeclaration: true });
});

test("selectionRange reproduces with positions[], the shape it actually takes", () => {
  const finding = triage([{ ...base, capability: "textDocument/selectionRange", status: "empty" }])[0];
  const params = JSON.parse(finding.reproduction.match(/'(\{.*\})'$/)![1]);
  expect(params.positions).toEqual([{ line: 1, character: 2 }]);
  expect(params.position).toBeUndefined();
});

test("ids are assigned after the sort, so A1 is the most severe finding", () => {
  const findings = triage([
    { ...base, durationMs: 4000 },                    // Low
    { ...base, capability: "textDocument/definition", status: "error" }, // Critical
  ], { slowMs: 1000 });
  expect(findings[0].id).toBe("A1");
  expect(findings[0].severity).toBe("Critical");
  expect(findings[1].id).toBe("A2");
});

test("a pipe in a server error message cannot break the table row", () => {
  // Pike type unions contain '|', so this is a realistic detail string.
  const markdown = renderFindings(
    triage([{ ...base, status: "error", detail: "Expected string|Stdio.File" }]),
  );
  const row = markdown.split("\n").find((l) => l.startsWith("| A1"))!;
  expect(row.split(/(?<!\\)\|/).length - 1).toBe(6); // 5 columns => 6 delimiters
  expect(markdown).toContain("string\\|Stdio.File");
});

test("every raw-fallback reproduction matches the params the matrix actually sends", () => {
  // A reproduction that runs but fires a DIFFERENT request than the sweep did
  // is worse than one that crashes: it looks fine and reproduces nothing. This
  // pins each raw-form capability against its matrix entry.
  for (const spec of MATRIX) {
    if (DEDICATED_METHODS.has(spec.method)) continue;
    const record = { ...base, capability: spec.method, status: "empty" as const };
    const reproduction = triage([record])[0].reproduction;
    const json = reproduction.match(/'(\{.*\})'$/)?.[1];
    expect(json).toBeDefined();
    const params = JSON.parse(json!) as Record<string, unknown>;

    // Whatever the matrix sends beyond textDocument must appear here too.
    const sent = spec.params({ uri: "file:///x.pike", position: record.position, text: "" });
    for (const key of Object.keys(sent as object)) {
      if (key === "textDocument") continue;
      expect(params[key]).toBeDefined();
    }
  }
});

test("notification capabilities use notify, not raw", () => {
  // `raw` uses sendRequest, and vscode-jsonrpc rejects a request for a
  // notification-only handler with "Unhandled method" before the server sees
  // it — so a raw command for these fails identically every time, whatever the
  // finding was. Verified by running both forms against a real corpus file.
  for (const method of ["workspace/didRenameFiles", "textDocument/didChange"]) {
    const finding = triage([{ ...base, capability: method, status: "error" }])[0];
    expect(finding.reproduction).toContain(`notify ${method}`);
    expect(finding.reproduction).not.toContain(`raw ${method}`);
  }
});

test("a notify reproduction has a live effect, not just a clean exit", async () => {
  // Three rounds of this task shipped reproduction commands that ran without
  // error while doing nothing. Asserting on the command STRING cannot catch
  // that; only observing the server's state can. Replacing the document with
  // an empty string must drop the symbol count to zero.
  const { spawnSync } = await import("node:child_process");
  const run = (args: string[]) =>
    spawnSync("bun", ["run", "scripts/lsp-probe.ts", ...args], {
      encoding: "utf8",
      timeout: 120_000,
    }).stdout ?? "";

  const output = run([
    "notify",
    "textDocument/didChange",
    "corpus/files/class-create.pike",
    '{"contentChanges":[{"text":""}]}',
  ]);

  expect(output).toContain("notification sent: textDocument/didChange");
  // The whole document was replaced with nothing, so nothing can be left.
  expect(output).toContain("server still responding: 0 symbols");
}, 180_000);

test("request capabilities still use raw, not notify", () => {
  const finding = triage([{ ...base, capability: "textDocument/references", status: "empty" }])[0];
  expect(finding.reproduction).toContain("raw textDocument/references");
  expect(finding.reproduction).not.toContain("notify");
});

test("a slow record that is also empty gets the more severe tier", () => {
  const findings = triage([{ ...base, status: "empty", durationMs: 9000 }], { slowMs: 1000 });
  expect(findings[0].severity).toBe("High");
  expect(findings[0].tier).toBe(1);
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

test("a declined request is not a finding", () => {
  // The counterpart to sweep.ts's classifyFailure: a ResponseError the server
  // chose to send is the handler working, so it must not reach the findings
  // table at any severity.
  const declined: LedgerRecord = {
    surface: "server",
    workspace: "corpus",
    capability: "textDocument/rename",
    file: "a.pike",
    position: { line: 0, character: 4 },
    status: "declined",
    durationMs: 3,
    rssBytes: 1,
    digest: "declined:-32600",
    detail: "No renamable symbol at the given position",
  };
  expect(triage([declined])).toEqual([]);
  // A crash at the same position still is one.
  expect(triage([{ ...declined, status: "error", detail: "boom" }])[0].severity).toBe("Critical");
});

test("findings sharing a root cause collapse into one group", () => {
  // On the corpus, 211 of 253 findings were a single defect repeated once per
  // single-occurrence symbol. Listed individually across 448 Roxen files that
  // cluster buries every other finding.
  const records: LedgerRecord[] = [
    { ...base, capability: "textDocument/documentHighlight", file: "a.pike", status: "empty" },
    { ...base, capability: "textDocument/documentHighlight", file: "b.pike", status: "empty" },
    { ...base, capability: "textDocument/documentHighlight", file: "b.pike", status: "empty" },
    { ...base, capability: "textDocument/completion", file: "c.pike", status: "empty" },
  ];
  const groups = groupFindings(triage(records));
  expect(groups).toHaveLength(2);
  const highlight = groups.find((g) => g.representative.capability === "textDocument/documentHighlight")!;
  expect(highlight.occurrences).toBe(3);
  expect(highlight.files).toBe(2);
});

test("grouping does not merge different severities", () => {
  const groups = groupFindings(triage([
    { ...base, capability: "textDocument/hover", status: "empty" },   // High
    { ...base, capability: "textDocument/hover", status: "error" },   // Critical
  ]));
  expect(groups).toHaveLength(2);
});

test("the grouped table reports occurrence counts", () => {
  const markdown = renderGrouped(triage([
    { ...base, capability: "textDocument/documentHighlight", file: "a.pike", status: "empty" },
    { ...base, capability: "textDocument/documentHighlight", file: "b.pike", status: "empty" },
  ]));
  expect(markdown).toContain("2 across 2 files");
  expect(markdown).toContain("G1");
});
