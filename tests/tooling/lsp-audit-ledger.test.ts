import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, readLedger, type LedgerRecord } from "../../tools/lsp-audit/ledger";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lsp-audit-")), "ledger.jsonl");
}

const SAMPLE: LedgerRecord = {
  surface: "server",
  workspace: "corpus",
  capability: "textDocument/hover",
  file: "basic-int-ranges.pike",
  position: { line: 3, character: 7 },
  status: "ok",
  durationMs: 12,
  rssBytes: 1024,
  digest: "hover:markdown:41",
};

test("round-trips records through the file", () => {
  const path = tmpPath();
  const ledger = new Ledger(path);
  ledger.append(SAMPLE);
  ledger.append({ ...SAMPLE, capability: "textDocument/definition", status: "empty" });
  ledger.close();

  const read = readLedger(path);
  expect(read).toHaveLength(2);
  expect(read[0].capability).toBe("textDocument/hover");
  expect(read[1].status).toBe("empty");
});

test("each append is flushed, so a record survives without close()", () => {
  const path = tmpPath();
  const ledger = new Ledger(path);
  ledger.append(SAMPLE);
  // Deliberately no close() — simulates a crash mid-sweep.
  expect(readLedger(path)).toHaveLength(1);
});

test("a truncated trailing line is dropped, not thrown on", () => {
  const path = tmpPath();
  const ledger = new Ledger(path);
  ledger.append(SAMPLE);
  ledger.close();
  // Simulate a crash partway through writing a second record.
  writeFileSync(path, readFileSync(path, "utf8") + '{"surface":"server","capa');

  const read = readLedger(path);
  expect(read).toHaveLength(1);
  expect(read[0].capability).toBe("textDocument/hover");
});
