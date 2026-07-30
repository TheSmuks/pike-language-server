import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, readLedger } from "../../tools/lsp-audit/ledger";
import { runSweep, withTimeout } from "../../tools/lsp-audit/sweep";
import { MATRIX } from "../../tools/lsp-audit/matrix";

test("sweeps one file and records a result for every capability", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lsp-audit-sweep-"));
  const file = join(dir, "greeter.pike");
  writeFileSync(file, `int counter;\n\nint bump() {\n  counter = counter + 1;\n  return counter;\n}\n`);

  const ledgerPath = join(dir, "ledger.jsonl");
  const ledger = new Ledger(ledgerPath);
  await runSweep({
    workspaceRoot: dir,
    workspaceName: "fixture",
    surface: "server",
    files: [file],
    ledger,
    maxRefsPerDecl: 1,
  });
  ledger.close();

  const records = readLedger(ledgerPath);
  const methods = new Set(records.map((r) => r.capability));
  for (const entry of MATRIX) {
    expect(methods.has(entry.method)).toBe(true);
  }
}, 120_000);

test("withTimeout rejects a request that never answers", async () => {
  // Tested directly rather than through the sweep. A Promise.race against a
  // timer cannot preempt an ALREADY-RESOLVED promise — the resolved value is a
  // microtask and the timer is a macrotask, so a fast handler wins even at
  // timeoutMs 0. Asserting "every capability times out" is therefore
  // unachievable, and this is the assertion that actually proves the bound.
  const never = new Promise(() => {});
  await expect(withTimeout(never, 10)).rejects.toThrow("__audit_timeout__");
});

test("a punishing timeout still completes the sweep instead of hanging", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lsp-audit-timeout-"));
  const file = join(dir, "tiny.pike");
  writeFileSync(file, "int counter;\nint bump() { return counter + 1; }\n");

  const ledgerPath = join(dir, "ledger.jsonl");
  const ledger = new Ledger(ledgerPath);
  await runSweep({
    workspaceRoot: dir,
    workspaceName: "fixture",
    surface: "server",
    files: [file],
    ledger,
    timeoutMs: 1,
  });
  ledger.close();

  const records = readLedger(ledgerPath);
  expect(records.length).toBeGreaterThan(0);
  // The point is resilience: no record may be left in an unknown state, and
  // runSweep must return rather than hang. Which capabilities happen to beat a
  // 1ms bound is a scheduling detail and is deliberately not asserted.
  const legal = new Set(["ok", "empty", "error", "timeout", "wrong"]);
  expect(records.every((r) => legal.has(r.status))).toBe(true);
}, 120_000);

test("lifecycle entries go through the notification path, not sendRequest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lsp-audit-lifecycle-"));
  const file = join(dir, "tiny.pike");
  writeFileSync(file, "int counter;\n");

  const ledgerPath = join(dir, "ledger.jsonl");
  const ledger = new Ledger(ledgerPath);
  await runSweep({
    workspaceRoot: dir,
    workspaceName: "fixture",
    surface: "server",
    files: [file],
    ledger,
  });
  ledger.close();

  // digest "notification" is set only by notifyAndRecord. If these had been
  // fired with sendRequest they would have hung to the timeout instead.
  const lifecycle = readLedger(ledgerPath).filter(
    (r) => r.capability === "workspace/didRenameFiles" || r.capability === "textDocument/didChange",
  );
  expect(lifecycle).toHaveLength(2);
  expect(lifecycle.every((r) => r.digest === "notification")).toBe(true);
  expect(lifecycle.every((r) => r.status === "ok")).toBe(true);
}, 120_000);
