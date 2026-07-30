import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger, readLedger } from "../../tools/lsp-audit/ledger";
import { classifyFailure, runSweep, withTimeout } from "../../tools/lsp-audit/sweep";
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

test("the sweep records real answers, not just records", async () => {
  // The coverage test above proves the matrix is wired into the loop, but it
  // would pass unchanged if every handler threw — attempt() writes a record on
  // every outcome, including "error". This test is what fails if the server is
  // actually broken. The four capabilities below are the ones a Pike class
  // fixture must always answer; they were verified to return "ok" against this
  // exact fixture before being asserted here.
  const dir = mkdtempSync(join(tmpdir(), "lsp-audit-health-"));
  const file = join(dir, "greeter.pike");
  writeFileSync(file, `class Greeter {
  string label;
  void create(string initial) { label = initial; }
  string speak() { return label + "!"; }
}
`);

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
  for (const capability of [
    "textDocument/hover",
    "textDocument/definition",
    "textDocument/documentSymbol",
    "textDocument/semanticTokens/full",
  ]) {
    const answered = records.filter((r) => r.capability === capability && r.status === "ok");
    expect(answered.length).toBeGreaterThan(0);
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
  const legal = new Set(["ok", "empty", "error", "timeout", "wrong", "declined"]);
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

test("a deliberate ResponseError is 'declined', not 'error'", () => {
  // The server's rename guard answers with ResponseError(InvalidRequest) at
  // every position that is not a renameable symbol. Classifying that as "error"
  // makes triage call it tier 0 → Critical, which on the corpus tier alone
  // produced 113 false Criticals and would produce thousands on Roxen.
  const declined = Object.assign(new Error("No renamable symbol at the given position"), {
    code: -32600,
  });
  expect(classifyFailure(declined)).toBe("declined");
  for (const code of [-32800, -32801, -32802, -32803]) {
    expect(classifyFailure(Object.assign(new Error("cancelled"), { code }))).toBe("declined");
  }
});

test("an unexpected server exception is still 'error'", () => {
  // The guard on the fix above: it must not swallow real crashes.
  // vscode-jsonrpc turns any non-ResponseError throw inside a handler into
  // InternalError (-32603) before the client sees it, so that code is the crash
  // signal and must stay tier 0. So must a capability the server advertises but
  // does not handle (-32601), and an error carrying no code at all.
  expect(classifyFailure(Object.assign(new Error("boom"), { code: -32603 }))).toBe("error");
  expect(classifyFailure(Object.assign(new Error("Unhandled method"), { code: -32601 }))).toBe("error");
  expect(classifyFailure(new Error("socket closed"))).toBe("error");
  expect(classifyFailure(new Error("__audit_timeout__"))).toBe("timeout");
});

test("declines on a real rename sweep are recorded as declined, not error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lsp-audit-decline-"));
  const file = join(dir, "tiny.pike");
  writeFileSync(file, "int main() { return 0; }\n");

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

  const renames = readLedger(ledgerPath).filter((r) => r.capability === "textDocument/rename");
  expect(renames.length).toBeGreaterThan(0);
  expect(renames.some((r) => r.status === "error")).toBe(false);
});
