# Full LSP Feature Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a behavioural sweep harness that exercises all 26 declared LSP capabilities against real Pike and Roxen source, then use it to produce `docs/audits/iteration-7.md`.

**Architecture:** Five small units under `tools/lsp-audit/` — a pure-data capability matrix, a pure-I/O JSONL ledger, a position deriver, a sweep driver that boots the real server via `createTestServer`, and a pure triage function from ledger records to findings. Docker-gated oracle classification decides whether a Roxen-tier defect is ours. Two additional probes cover the standalone and client surfaces.

**Tech Stack:** TypeScript, Bun (runtime + test runner), `vscode-languageserver` protocol types, Docker (`pike-lsp/roxen-lab:6.1`), Pike 8.0.

**Design doc:** `docs/superpowers/specs/2026-07-30-full-lsp-feature-audit-design.md`

## Global Constraints

- **TigerStyle limits, enforced by CI (`quality-gates`):** files ≤500 lines, functions ≤50 lines.
- **tree-sitter positions are UTF-16 code units.** Never add a byte/unit conversion anywhere. LSP positions and tree-sitter positions are already in the same space.
- **Pike is the oracle.** No Roxen-tier finding is recorded without a verdict from `oracle.pike`, or an explicit `unclassified` marker.
- **Commits:** conventional-commit types only (`feat`, `fix`, `test`, `docs`, `refactor`, `chore`). Prefix every commit command with `PRE_COMMIT_ALLOW_NO_CONFIG=1`.
- **No AI attribution** in commit messages, bodies, trailers, code comments, or documentation.
- **Test runner is `bun test`.** `typecheck` (`bun run typecheck`) is a separate gate — run both.
- **Source decoding:** use `decodeSource` from `server/src/util/sourceDecoder`, never a hardcoded `utf-8` read.
- **This tool is never wired into CI.** No workflow file changes.

## Spec Amendment (read before Task 6)

The design doc says "only the corpus tier gets expected values" without saying where those values come from. Hand-authoring expectations for 80 files × 26 capabilities is not tractable and would not be worth it. **Tier 2 is therefore scoped to a curated subset:** hand-written assertions for five high-value capabilities (definition, hover, references, prepareRename, completion) across ten corpus files where the correct answer is unambiguous. Task 6 builds exactly that. Tiers 0, 1, and 3 remain full-coverage.

## File Structure

| File | Responsibility | Depends on |
|---|---|---|
| `tools/lsp-audit/ledger.ts` | Append-only JSONL writer with per-record flush; tolerant reader. | `node:fs` only |
| `tools/lsp-audit/matrix.ts` | Declarative capability list: method, driver, params builder, result validator. Pure data. | LSP types |
| `tools/lsp-audit/positions.ts` | Derive sweep positions from a document without relying on audited features. | `node:fs` only |
| `tools/lsp-audit/sweep.ts` | Boots the server, walks workspace × matrix, writes ledger records. | matrix, positions, ledger, `tests/lsp/helpers` |
| `tools/lsp-audit/oracle.ts` | Runs `oracle.pike` in the lab container; returns verdicts. | `node:child_process` |
| `tools/lsp-audit/expectations.ts` | Tier-2 correctness expectations for the curated corpus subset. | matrix types |
| `tools/lsp-audit/triage.ts` | Pure function: ledger records + verdicts + expectations → findings; markdown renderer. | ledger, oracle, expectations |
| `tools/lsp-audit/cli.ts` | Entry point wiring the above into `sweep` / `triage` subcommands. | all |
| `tools/lsp-audit/standalone-sweep.mjs` | Surface 4: full sweep over real stdio as a non-VSCode client. | `node:child_process` |
| `tests/integration/suite/clientSurface.test.ts` | Surface 3: activation, settings plumbing, grammar/semantic agreement. | vscode test API |

---

### Task 1: Ledger

**Files:**
- Create: `tools/lsp-audit/ledger.ts`
- Test: `tests/tooling/lsp-audit-ledger.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Tier = 0 | 1 | 2 | 3`; `type Surface = "server" | "roxen" | "client" | "standalone"`; `type Status = "ok" | "empty" | "error" | "timeout"`; `interface LedgerRecord`; `class Ledger { constructor(path: string); append(r: LedgerRecord): void; close(): void }`; `function readLedger(path: string): LedgerRecord[]`.

- [ ] **Step 1: Write the failing test**

Create `tests/tooling/lsp-audit-ledger.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tooling/lsp-audit-ledger.test.ts`
Expected: FAIL — cannot resolve module `../../tools/lsp-audit/ledger`.

- [ ] **Step 3: Write minimal implementation**

Create `tools/lsp-audit/ledger.ts`:

```ts
/**
 * Append-only JSONL ledger for the LSP audit sweep.
 *
 * Every record is flushed as it is written. A sweep over the Roxen tree runs
 * for tens of minutes; a crash must cost one record, not the run. Triage then
 * reads the persisted ledger, so re-triaging with different thresholds never
 * requires re-sweeping.
 */

import { closeSync, openSync, readFileSync, writeSync, existsSync } from "node:fs";

export type Tier = 0 | 1 | 2 | 3;
export type Surface = "server" | "roxen" | "client" | "standalone";
/**
 * "wrong" means the server answered, but not with the known-correct answer.
 * It can only be decided while the result is in hand, so the sweep sets it —
 * the ledger stores a digest, not the result, and triage cannot recover it.
 */
export type Status = "ok" | "empty" | "error" | "timeout" | "wrong";

export interface LedgerRecord {
  surface: Surface;
  /** Workspace label, e.g. "corpus" or "roxen-6.1". */
  workspace: string;
  /** LSP method, e.g. "textDocument/hover". */
  capability: string;
  /** Workspace-relative path. */
  file: string;
  /** Null for document-, workspace- and lifecycle-driven capabilities. */
  position: { line: number; character: number } | null;
  status: Status;
  durationMs: number;
  rssBytes: number;
  /** Short summary of the result, enough for triage without storing it all. */
  digest: string;
  /** Error text when status is "error". */
  detail?: string;
}

export class Ledger {
  private fd: number;

  constructor(path: string) {
    this.fd = openSync(path, "a");
  }

  append(record: LedgerRecord): void {
    writeSync(this.fd, JSON.stringify(record) + "\n");
  }

  close(): void {
    closeSync(this.fd);
  }
}

/**
 * Read a ledger, discarding a trailing partial line.
 *
 * A crash mid-write leaves an incomplete final record. That is expected, not
 * corruption, so it is dropped silently rather than thrown on.
 */
export function readLedger(path: string): LedgerRecord[] {
  if (!existsSync(path)) return [];
  const records: LedgerRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as LedgerRecord);
    } catch {
      // Partial trailing line from an interrupted sweep.
    }
  }
  return records;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/tooling/lsp-audit-ledger.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
PRE_COMMIT_ALLOW_NO_CONFIG=1 git add tools/lsp-audit/ledger.ts tests/tooling/lsp-audit-ledger.test.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "feat(audit): add append-only ledger for the LSP sweep"
```

---

### Task 2: Capability matrix

**Files:**
- Create: `tools/lsp-audit/matrix.ts`
- Test: `tests/tooling/lsp-audit-matrix.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type Driver = "position" | "document" | "workspace" | "lifecycle"`; `interface RequestContext { uri: string; position: { line: number; character: number } | null; text: string }`; `interface CapabilitySpec { method: string; driver: Driver; declaredBy: string; params(ctx: RequestContext): unknown; validate(result: unknown): "ok" | "empty" }`; `const MATRIX: CapabilitySpec[]`.

The `declaredBy` field is the key in `buildServerCapabilities().capabilities` that advertises the method. The test in this task asserts every declared key is covered — that is the mechanism that catches a capability being advertised without ever being exercised, which is how `documentRangeFormatting` came to be declared while iteration-6 recorded it unimplemented.

- [ ] **Step 1: Write the failing test**

Create `tests/tooling/lsp-audit-matrix.test.ts`:

```ts
import { test, expect } from "bun:test";
import { MATRIX } from "../../tools/lsp-audit/matrix";
import { buildServerCapabilities } from "../../server/src/serverCapabilities";

test("every declared server capability has at least one matrix entry", () => {
  const declared = Object.keys(buildServerCapabilities().capabilities);
  const covered = new Set(MATRIX.map((entry) => entry.declaredBy));
  const uncovered = declared.filter((key) => !covered.has(key));
  expect(uncovered).toEqual([]);
});

test("every matrix entry names a capability the server actually declares", () => {
  const declared = new Set(Object.keys(buildServerCapabilities().capabilities));
  const orphans = MATRIX.filter((e) => !declared.has(e.declaredBy)).map((e) => e.method);
  expect(orphans).toEqual([]);
});

test("position-driven entries build params carrying the position", () => {
  const hover = MATRIX.find((e) => e.method === "textDocument/hover");
  expect(hover?.driver).toBe("position");
  const params = hover!.params({
    uri: "file:///x.pike",
    position: { line: 2, character: 4 },
    text: "",
  }) as { position: { line: number } };
  expect(params.position.line).toBe(2);
});

test("validate distinguishes an answer from an empty result", () => {
  const definition = MATRIX.find((e) => e.method === "textDocument/definition")!;
  expect(definition.validate(null)).toBe("empty");
  expect(definition.validate([])).toBe("empty");
  expect(definition.validate([{ uri: "file:///x.pike" }])).toBe("ok");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tooling/lsp-audit-matrix.test.ts`
Expected: FAIL — cannot resolve `../../tools/lsp-audit/matrix`.

- [ ] **Step 3: Write minimal implementation**

Create `tools/lsp-audit/matrix.ts`. Keep it under 500 lines by using the shared helpers below rather than repeating validators.

```ts
/**
 * Declarative capability matrix for the LSP audit sweep.
 *
 * Pure data: no I/O, no server. Each entry says how to build a request and how
 * to tell an answer from an empty result. `declaredBy` ties the entry back to
 * the key in buildServerCapabilities() that advertises it, which lets the test
 * suite fail when a capability is advertised but never swept.
 */

export type Driver = "position" | "document" | "workspace" | "lifecycle";

export interface RequestContext {
  uri: string;
  position: { line: number; character: number } | null;
  text: string;
  /** Set only for semanticTokens/full/delta, by the driver's edit cycle. */
  previousResultId?: string;
}

export interface CapabilitySpec {
  method: string;
  driver: Driver;
  declaredBy: string;
  params(ctx: RequestContext): unknown;
  validate(result: unknown): "ok" | "empty";
}

// --- shared param builders -------------------------------------------------

const doc = (ctx: RequestContext) => ({ textDocument: { uri: ctx.uri } });
const at = (ctx: RequestContext) => ({ ...doc(ctx), position: ctx.position });

/** Whole-document range, for range-scoped requests. */
function fullRange(ctx: RequestContext) {
  const lines = ctx.text.split("\n");
  return {
    start: { line: 0, character: 0 },
    end: { line: Math.max(0, lines.length - 1), character: lines[lines.length - 1]?.length ?? 0 },
  };
}

// --- shared validators -----------------------------------------------------

/** Non-null, and non-empty when the result is an array. */
function nonEmpty(result: unknown): "ok" | "empty" {
  if (result === null || result === undefined) return "empty";
  if (Array.isArray(result)) return result.length > 0 ? "ok" : "empty";
  return "ok";
}

/** Anything at all, including an empty array. Used where empty is a legal answer. */
function anyResult(result: unknown): "ok" | "empty" {
  return result === undefined ? "empty" : "ok";
}

/** Completion returns either an array or a CompletionList. */
function completionNonEmpty(result: unknown): "ok" | "empty" {
  if (result === null || result === undefined) return "empty";
  if (Array.isArray(result)) return result.length > 0 ? "ok" : "empty";
  const items = (result as { items?: unknown[] }).items;
  return Array.isArray(items) && items.length > 0 ? "ok" : "empty";
}

/** Semantic tokens: the flat data array must be non-empty for a non-empty file. */
function tokensNonEmpty(result: unknown): "ok" | "empty" {
  const data = (result as { data?: number[] } | null)?.data;
  return Array.isArray(data) && data.length > 0 ? "ok" : "empty";
}

/**
 * A delta reply is legally either an edit list or a full token set. Both count
 * as an answer; only null does not. Whether the edits are *correct* is checked
 * by the driver, which knows what edit it made.
 */
function deltaAnswered(result: unknown): "ok" | "empty" {
  if (result === null || result === undefined) return "empty";
  const asDelta = result as { edits?: unknown[]; data?: unknown[] };
  return Array.isArray(asDelta.edits) || Array.isArray(asDelta.data) ? "ok" : "empty";
}

// --- the matrix ------------------------------------------------------------

export const MATRIX: CapabilitySpec[] = [
  // Position-driven.
  { method: "textDocument/hover", driver: "position", declaredBy: "hoverProvider", params: at, validate: nonEmpty },
  { method: "textDocument/definition", driver: "position", declaredBy: "definitionProvider", params: at, validate: nonEmpty },
  { method: "textDocument/declaration", driver: "position", declaredBy: "declarationProvider", params: at, validate: nonEmpty },
  { method: "textDocument/typeDefinition", driver: "position", declaredBy: "typeDefinitionProvider", params: at, validate: anyResult },
  { method: "textDocument/implementation", driver: "position", declaredBy: "implementationProvider", params: at, validate: anyResult },
  {
    method: "textDocument/references",
    driver: "position",
    declaredBy: "referencesProvider",
    params: (ctx) => ({ ...at(ctx), context: { includeDeclaration: true } }),
    validate: nonEmpty,
  },
  { method: "textDocument/prepareRename", driver: "position", declaredBy: "renameProvider", params: at, validate: anyResult },
  {
    method: "textDocument/rename",
    driver: "position",
    declaredBy: "renameProvider",
    params: (ctx) => ({ ...at(ctx), newName: "auditRenamedSymbol" }),
    validate: anyResult,
  },
  { method: "textDocument/documentHighlight", driver: "position", declaredBy: "documentHighlightProvider", params: at, validate: nonEmpty },
  {
    method: "textDocument/signatureHelp",
    driver: "position",
    declaredBy: "signatureHelpProvider",
    params: (ctx) => ({ ...at(ctx), context: { triggerKind: 1, isRetrigger: false } }),
    validate: anyResult,
  },
  {
    method: "textDocument/selectionRange",
    driver: "position",
    declaredBy: "selectionRangeProvider",
    params: (ctx) => ({ ...doc(ctx), positions: [ctx.position] }),
    validate: nonEmpty,
  },
  { method: "textDocument/prepareCallHierarchy", driver: "position", declaredBy: "callHierarchyProvider", params: at, validate: anyResult },
  { method: "textDocument/prepareTypeHierarchy", driver: "position", declaredBy: "typeHierarchyProvider", params: at, validate: anyResult },
  {
    method: "textDocument/completion",
    driver: "position",
    declaredBy: "completionProvider",
    params: (ctx) => ({ ...at(ctx), context: { triggerKind: 1 } }),
    validate: completionNonEmpty,
  },

  // Document-driven.
  { method: "textDocument/documentSymbol", driver: "document", declaredBy: "documentSymbolProvider", params: doc, validate: nonEmpty },
  { method: "textDocument/semanticTokens/full", driver: "document", declaredBy: "semanticTokensProvider", params: doc, validate: tokensNonEmpty },
  {
    method: "textDocument/semanticTokens/range",
    driver: "document",
    declaredBy: "semanticTokensProvider",
    params: (ctx) => ({ ...doc(ctx), range: fullRange(ctx) }),
    validate: tokensNonEmpty,
  },
  {
    // Driven by the sweep's edit cycle, not a bare request: a delta bug is
    // invisible until a specific edit sequence produces a wrong patch.
    method: "textDocument/semanticTokens/full/delta",
    driver: "document",
    declaredBy: "semanticTokensProvider",
    params: (ctx) => ({ ...doc(ctx), previousResultId: ctx.previousResultId ?? "" }),
    validate: deltaAnswered,
  },
  { method: "textDocument/foldingRange", driver: "document", declaredBy: "foldingRangeProvider", params: doc, validate: nonEmpty },
  { method: "textDocument/inlayHint", driver: "document", declaredBy: "inlayHintProvider", params: (ctx) => ({ ...doc(ctx), range: fullRange(ctx) }), validate: anyResult },
  { method: "textDocument/documentLink", driver: "document", declaredBy: "documentLinkProvider", params: doc, validate: anyResult },
  { method: "textDocument/codeLens", driver: "document", declaredBy: "codeLensProvider", params: doc, validate: anyResult },
  {
    method: "textDocument/codeAction",
    driver: "document",
    declaredBy: "codeActionProvider",
    params: (ctx) => ({ ...doc(ctx), range: fullRange(ctx), context: { diagnostics: [] } }),
    validate: anyResult,
  },
  {
    method: "textDocument/formatting",
    driver: "document",
    declaredBy: "documentFormattingProvider",
    params: (ctx) => ({ ...doc(ctx), options: { tabSize: 2, insertSpaces: true } }),
    validate: anyResult,
  },
  {
    method: "textDocument/rangeFormatting",
    driver: "document",
    declaredBy: "documentRangeFormattingProvider",
    params: (ctx) => ({ ...doc(ctx), range: fullRange(ctx), options: { tabSize: 2, insertSpaces: true } }),
    validate: anyResult,
  },
  {
    method: "textDocument/onTypeFormatting",
    driver: "document",
    declaredBy: "documentOnTypeFormattingProvider",
    params: (ctx) => ({ ...doc(ctx), position: { line: 0, character: 0 }, ch: "}", options: { tabSize: 2, insertSpaces: true } }),
    validate: anyResult,
  },

  // Workspace-driven.
  {
    method: "workspace/symbol",
    driver: "workspace",
    declaredBy: "workspaceSymbolProvider",
    params: () => ({ query: "create" }),
    validate: nonEmpty,
  },
  // Lifecycle. These are NOTIFICATIONS, not requests — the server implements
  // onDidRenameFiles and onDidChange, neither of which returns a response.
  // Firing them with sendRequest would hang until the timeout and report a
  // false Critical on every file, so the driver sends them as notifications
  // and records that the server survived. The entries exist here so the
  // coverage test still sees their declared keys.
  {
    method: "workspace/didRenameFiles",
    driver: "lifecycle",
    declaredBy: "workspace",
    params: (ctx) => ({ files: [{ oldUri: ctx.uri, newUri: ctx.uri.replace(/\.pike$/, "-renamed.pike") }] }),
    validate: anyResult,
  },
  {
    method: "textDocument/didChange",
    driver: "lifecycle",
    declaredBy: "textDocumentSync",
    params: (ctx) => ({
      textDocument: { uri: ctx.uri, version: 3 },
      contentChanges: [{ text: ctx.text }],
    }),
    validate: anyResult,
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/tooling/lsp-audit-matrix.test.ts`
Expected: PASS, 4 tests. If the first test fails listing an uncovered key, add a matrix entry for it — do not edit the test to pass.

- [ ] **Step 5: Typecheck**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
PRE_COMMIT_ALLOW_NO_CONFIG=1 git add tools/lsp-audit/matrix.ts tests/tooling/lsp-audit-matrix.test.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "feat(audit): add capability matrix with declared-coverage test"
```

---

### Task 3: Position derivation

**Files:**
- Create: `tools/lsp-audit/positions.ts`
- Test: `tests/tooling/lsp-audit-positions.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface SweepPosition { line: number; character: number; symbol: string; kind: "declaration" | "reference" }`; `function derivePositions(text: string, symbolNames: string[], maxRefsPerDecl?: number): SweepPosition[]`; `function lexicalIdentifiers(text: string): string[]`.

**Why this is its own unit.** Positions must not be derived from a feature under audit, or a broken feature hides itself — if `documentSymbol` returns nothing and we derive positions from it, every other capability gets swept at zero positions and the run reports a clean bill of health. So: the sweep passes in whatever `documentSymbol` gave it, and this module falls back to a lexical identifier scan when that list is empty. Positions are UTF-16 code units throughout, matching LSP and tree-sitter; no conversion.

- [ ] **Step 1: Write the failing test**

Create `tests/tooling/lsp-audit-positions.test.ts`:

```ts
import { test, expect } from "bun:test";
import { derivePositions, lexicalIdentifiers } from "../../tools/lsp-audit/positions";

const SRC = `int counter;

int bump() {
  counter = counter + 1;
  return counter;
}
`;

test("finds the declaration and its references", () => {
  const positions = derivePositions(SRC, ["counter"]);
  expect(positions[0]).toEqual({ line: 0, character: 4, symbol: "counter", kind: "declaration" });
  expect(positions.filter((p) => p.kind === "reference").length).toBe(3);
});

test("caps reference sites per declaration", () => {
  const many = "int x;\n" + "int f() { return x + x + x + x + x + x + x; }\n";
  const positions = derivePositions(many, ["x"], 2);
  expect(positions.filter((p) => p.kind === "reference").length).toBe(2);
});

test("falls back to a lexical scan when no symbol names are supplied", () => {
  const positions = derivePositions(SRC, []);
  expect(positions.length).toBeGreaterThan(0);
  expect(positions.some((p) => p.symbol === "bump")).toBe(true);
});

test("does not match identifiers inside longer words", () => {
  const positions = derivePositions("int x;\nint xylophone;\n", ["x"]);
  expect(positions).toHaveLength(1);
  expect(positions[0].kind).toBe("declaration");
});

test("positions are UTF-16 code units, so astral characters count as two", () => {
  // The emoji is one code point but two UTF-16 units, matching how both LSP
  // and tree-sitter count. Verified against the real values: a UTF-16 scan
  // puts "after" at 21, a byte-based scan would put it at 23. Asserting 21 is
  // what makes this test catch an accidental byte conversion.
  const positions = derivePositions('string s = "\u{1F600}"; int after;\n', ["after"]);
  expect(positions[0].character).toBe(21);
});

test("lexicalIdentifiers skips Pike keywords", () => {
  expect(lexicalIdentifiers("int x; return x;")).not.toContain("return");
  expect(lexicalIdentifiers("int x; return x;")).toContain("x");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tooling/lsp-audit-positions.test.ts`
Expected: FAIL — cannot resolve `../../tools/lsp-audit/positions`.

- [ ] **Step 3: Write minimal implementation**

Create `tools/lsp-audit/positions.ts`:

```ts
/**
 * Derive sweep positions for a document.
 *
 * Positions must not come from a feature under audit. If documentSymbol is
 * broken and we take positions from it, every other capability is swept at
 * zero positions and the run reports a clean bill of health. So the sweep
 * passes in whatever documentSymbol produced, and this module falls back to a
 * lexical identifier scan when that comes back empty.
 *
 * All columns are UTF-16 code units, which is what LSP and tree-sitter both
 * use. JavaScript string indices are already in that space — no conversion.
 */

export interface SweepPosition {
  line: number;
  character: number;
  symbol: string;
  kind: "declaration" | "reference";
}

/** Reserved words that are never useful sweep targets. */
const KEYWORDS = new Set([
  "array", "break", "case", "catch", "class", "constant", "continue", "default",
  "do", "else", "enum", "extern", "final", "float", "for", "foreach", "function",
  "gauge", "global", "if", "import", "inherit", "inline", "int", "lambda",
  "local", "mapping", "mixed", "multiset", "object", "optional", "predef",
  "private", "program", "protected", "public", "return", "sscanf", "static",
  "string", "switch", "typedef", "typeof", "variant", "void", "while", "zero",
]);

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/g;

/** Every identifier in source order, keywords removed, duplicates kept. */
export function lexicalIdentifiers(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(IDENTIFIER)) {
    if (!KEYWORDS.has(match[0])) found.push(match[0]);
  }
  return found;
}

/** Convert a string offset to a line/character pair in UTF-16 code units. */
function toPosition(text: string, offset: number): { line: number; character: number } {
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, character: offset - lineStart };
}

/**
 * Positions for the given symbols: the first occurrence of each is treated as
 * its declaration, and up to `maxRefsPerDecl` later occurrences as references.
 *
 * When `symbolNames` is empty, every distinct lexical identifier is used
 * instead, so a file still gets swept when documentSymbol returns nothing.
 */
export function derivePositions(
  text: string,
  symbolNames: string[],
  maxRefsPerDecl = 5,
): SweepPosition[] {
  const names = symbolNames.length > 0 ? symbolNames : [...new Set(lexicalIdentifiers(text))];
  const positions: SweepPosition[] = [];

  for (const name of names) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(name)}(?![A-Za-z0-9_])`, "g");
    let seen = 0;
    for (const match of text.matchAll(pattern)) {
      if (seen > maxRefsPerDecl) break;
      const { line, character } = toPosition(text, match.index);
      positions.push({ line, character, symbol: name, kind: seen === 0 ? "declaration" : "reference" });
      seen++;
    }
  }
  return positions;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/tooling/lsp-audit-positions.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
PRE_COMMIT_ALLOW_NO_CONFIG=1 git add tools/lsp-audit/positions.ts tests/tooling/lsp-audit-positions.test.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "feat(audit): derive sweep positions independently of audited features"
```

---

### Task 4: Sweep driver

**Files:**
- Create: `tools/lsp-audit/sweep.ts`
- Test: `tests/tooling/lsp-audit-sweep.test.ts`

**Interfaces:**
- Consumes: `Ledger`, `LedgerRecord`, `Surface` (Task 1); `MATRIX`, `CapabilitySpec` (Task 2); `derivePositions`, `SweepPosition` (Task 3); `createTestServer`, `TestServer` from `tests/lsp/helpers`.
- Produces: `interface SweepOptions { workspaceRoot: string; workspaceName: string; surface: Surface; files: string[]; ledger: Ledger; timeoutMs?: number; slowMs?: number; maxRefsPerDecl?: number }`; `async function runSweep(options: SweepOptions): Promise<void>`.

Defaults, from the design doc: `timeoutMs` 10000, `slowMs` 1000, `maxRefsPerDecl` 5.

- [ ] **Step 1: Write the failing test**

Create `tests/tooling/lsp-audit-sweep.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tooling/lsp-audit-sweep.test.ts`
Expected: FAIL — cannot resolve `../../tools/lsp-audit/sweep`.

- [ ] **Step 3: Write minimal implementation**

Create `tools/lsp-audit/sweep.ts`. Watch the 50-line function limit — the per-capability request is its own function.

```ts
/**
 * Sweep driver: boots the real server and fires every capability at every
 * meaningful position, writing one ledger record per attempt.
 *
 * The server comes up through createTestServer, the same path lsp-probe uses,
 * so this exercises production code rather than a parallel implementation.
 */

import { basename, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { createTestServer, type TestServer } from "../../tests/lsp/helpers";
import { decodeSource } from "../../server/src/util/sourceDecoder";
import { MATRIX, type CapabilitySpec, type RequestContext } from "./matrix";
import { derivePositions, type SweepPosition } from "./positions";
import { Ledger, type LedgerRecord, type Status, type Surface } from "./ledger";

/**
 * Decides whether a result is the known-correct one.
 *
 * Returns null when no expectation covers this (file, method, position), which
 * is the common case. Injected rather than imported so the sweep stays
 * independent of the expectation set — see Task 6.
 */
export type CorrectnessChecker = (
  file: string,
  method: string,
  position: { line: number; character: number } | null,
  result: unknown,
) => boolean | null;

export interface SweepOptions {
  workspaceRoot: string;
  workspaceName: string;
  surface: Surface;
  files: string[];
  ledger: Ledger;
  timeoutMs?: number;
  slowMs?: number;
  maxRefsPerDecl?: number;
  /** Tier-2 checking. Omitted for the Roxen tier, where answers are unknown. */
  checker?: CorrectnessChecker;
  /**
   * Positions that must be swept regardless of what documentSymbol names,
   * keyed by workspace-relative path.
   *
   * Without this, tier 2 is decorative: `symbolNames` returns only TOP-LEVEL
   * documentSymbol names, so expectations targeting fields, locals and class
   * members are never visited — measured at 1 of 20 reachable. Recursing into
   * `children` only reaches 8 of 20, because documentSymbol emits no field or
   * local declarations at all. The expectation coordinates are the right
   * targets; the position source is too narrow, so they are unioned in here.
   */
  extraPositions?: Map<string, Array<{ line: number; character: number }>>;
}

interface Outcome {
  status: Status;
  digest: string;
  detail?: string;
  durationMs: number;
}

/** Send one request, bounded by the timeout, and classify what came back. */
async function attempt(
  server: TestServer,
  spec: CapabilitySpec,
  ctx: RequestContext,
  timeoutMs: number,
  checkCorrect?: (result: unknown) => boolean | null,
): Promise<Outcome> {
  const started = performance.now();
  try {
    const result = await withTimeout(
      server.client.sendRequest(spec.method, spec.params(ctx)),
      timeoutMs,
    );
    // A wrong answer outranks an empty one: both are defects, but "answered
    // incorrectly" is the more specific claim, so it wins when both apply.
    const correct = checkCorrect?.(result) ?? null;
    return {
      status: correct === false ? "wrong" : spec.validate(result),
      digest: digestOf(result),
      durationMs: performance.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: message === "__audit_timeout__" ? "timeout" : "error",
      digest: "",
      detail: message,
      durationMs: performance.now() - started,
    };
  }
}

/** Exported so the timeout bound can be tested directly — see Task 4's tests. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("__audit_timeout__")), ms),
    ),
  ]);
}

/** A short, comparable summary — enough for triage without storing the result. */
function digestOf(result: unknown): string {
  if (result === null || result === undefined) return "null";
  if (Array.isArray(result)) return `array:${result.length}`;
  const data = (result as { data?: unknown[] }).data;
  if (Array.isArray(data)) return `tokens:${data.length}`;
  const items = (result as { items?: unknown[] }).items;
  if (Array.isArray(items)) return `items:${items.length}`;
  return `object:${Object.keys(result as object).length}`;
}

/** Ask the server for declaration names, tolerating a broken documentSymbol. */
async function symbolNames(server: TestServer, uri: string, timeoutMs: number): Promise<string[]> {
  try {
    const symbols = await withTimeout(
      server.client.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }),
      timeoutMs,
    );
    if (!Array.isArray(symbols)) return [];
    return symbols
      .map((s: { name?: string }) => s.name)
      .filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}

/**
 * Prime the delta cycle: ask for full tokens, then edit the document.
 *
 * A delta request against an unchanged document is not a test of anything —
 * the interesting case is whether the server's patch is right after a real
 * edit. Returns the resultId to send back, or "" if the full request failed.
 */
async function primeDelta(server: TestServer, uri: string, text: string, timeoutMs: number): Promise<string> {
  try {
    const full = await withTimeout(
      server.client.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri } }),
      timeoutMs,
    );
    server.client.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: text + "\nint auditProbeSymbol;\n" }],
    });
    return (full as { resultId?: string } | null)?.resultId ?? "";
  } catch {
    return "";
  }
}

/**
 * Send a lifecycle notification and record that the server survived it.
 *
 * A notification has no reply, so there is nothing to validate. What is being
 * tested is that the server accepts it without throwing — a handler that
 * crashes on didRenameFiles takes the whole session down, which is exactly the
 * kind of defect this audit exists to find.
 */
function notifyAndRecord(
  server: TestServer,
  spec: CapabilitySpec,
  ctx: RequestContext,
  options: SweepOptions,
  relPath: string,
): LedgerRecord {
  const started = performance.now();
  let status: Status = "ok";
  let detail: string | undefined;
  try {
    server.client.sendNotification(spec.method, spec.params(ctx));
  } catch (error) {
    status = "error";
    detail = error instanceof Error ? error.message : String(error);
  }
  return {
    surface: options.surface,
    workspace: options.workspaceName,
    capability: spec.method,
    file: relPath,
    position: null,
    status,
    durationMs: Math.round(performance.now() - started),
    rssBytes: process.memoryUsage().rss,
    digest: "notification",
    detail,
  };
}

/**
 * Union required positions into the derived set, skipping duplicates.
 *
 * Marked `kind: "declaration"` because these are explicitly-chosen targets, not
 * incidental occurrences; the cap in derivePositions does not apply to them.
 */
function withExtraPositions(
  derived: SweepPosition[],
  extra: Array<{ line: number; character: number }> | undefined,
): SweepPosition[] {
  if (!extra || extra.length === 0) return derived;
  const seen = new Set(derived.map((p) => `${p.line}:${p.character}`));
  const merged = [...derived];
  for (const position of extra) {
    const key = `${position.line}:${position.character}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push({ ...position, symbol: "<required>", kind: "declaration" });
  }
  return merged;
}

/** Sweep one file across the whole matrix. */
async function sweepFile(
  server: TestServer,
  file: string,
  options: SweepOptions,
  write: (record: LedgerRecord) => void,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  // decodeSource returns a DecodedSource record, not a string — the sniffed
  // encoding rides along with the text. Never substitute a hardcoded utf-8 read.
  const text = decodeSource(readFileSync(file)).text;
  const uri = pathToFileURL(file).href;
  server.openDoc(uri, text, "pike");

  const names = await symbolNames(server, uri, timeoutMs);
  const relPath = relative(options.workspaceRoot, file) || basename(file);
  const positions = withExtraPositions(
    derivePositions(text, names, options.maxRefsPerDecl ?? 5),
    options.extraPositions?.get(relPath),
  );
  const previousResultId = await primeDelta(server, uri, text, timeoutMs);

  for (const spec of MATRIX) {
    // Lifecycle entries are notifications with no response; sendRequest would
    // hang on them until the timeout. They are driven separately, below.
    if (spec.driver === "lifecycle") {
      write(notifyAndRecord(server, spec, { uri, position: null, text }, options, relPath));
      continue;
    }
    const targets: (SweepPosition | null)[] =
      spec.driver === "position" ? positions : [null];
    for (const target of targets) {
      const ctx: RequestContext = {
        uri,
        position: target ? { line: target.line, character: target.character } : null,
        text,
        previousResultId,
      };
      const outcome = await attempt(server, spec, ctx, timeoutMs, (result) =>
        options.checker?.(relPath, spec.method, ctx.position, result) ?? null,
      );
      write({
        surface: options.surface,
        workspace: options.workspaceName,
        capability: spec.method,
        file: relPath,
        position: ctx.position,
        status: outcome.status,
        durationMs: Math.round(outcome.durationMs),
        rssBytes: process.memoryUsage().rss,
        digest: outcome.digest,
        detail: outcome.detail,
      });
    }
  }
}

/** Run the sweep over every file in the workspace. */
export async function runSweep(options: SweepOptions): Promise<void> {
  const server = await createTestServer({
    rootUri: pathToFileURL(options.workspaceRoot).href,
  });

  // Diagnostics are pushed, not requested: the server is push-only by design
  // and advertises no diagnosticProvider. Its absence is not a finding — but a
  // file that never receives a publish notification at all is one, so record
  // what arrives and let triage compare against the files swept.
  server.client.onNotification(
    "textDocument/publishDiagnostics",
    (params: { uri: string; diagnostics: unknown[] }) => {
      options.ledger.append({
        surface: options.surface,
        workspace: options.workspaceName,
        capability: "textDocument/publishDiagnostics",
        file: relative(options.workspaceRoot, new URL(params.uri).pathname),
        position: null,
        status: "ok",
        durationMs: 0,
        rssBytes: process.memoryUsage().rss,
        digest: `array:${params.diagnostics.length}`,
      });
    },
  );

  try {
    for (const file of options.files) {
      await sweepFile(server, file, options, (record) => options.ledger.append(record));
    }
  } finally {
    await server.teardown();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/tooling/lsp-audit-sweep.test.ts`
Expected: PASS, 2 tests. These boot a real server, so allow up to two minutes.

- [ ] **Step 5: Check the file-size gate**

Run: `wc -l tools/lsp-audit/sweep.ts`
Expected: under 500. If over, extract `attempt`/`digestOf` into `tools/lsp-audit/request.ts`.

- [ ] **Step 6: Commit**

```bash
PRE_COMMIT_ALLOW_NO_CONFIG=1 git add tools/lsp-audit/sweep.ts tests/tooling/lsp-audit-sweep.test.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "feat(audit): add sweep driver over the capability matrix"
```

---

### Task 5: Oracle gate

**Files:**
- Create: `tools/lsp-audit/oracle.ts`
- Test: `tests/tooling/lsp-audit-oracle.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type Verdict = "ok" | "semantic" | "cpp_error" | "syntax" | "unreadable" | "unavailable"`; `interface OracleResult { file: string; verdict: Verdict; detail?: string }`; `function oracleAvailable(): boolean`; `function classify(relativeFiles: string[], roxenRoot: string): Map<string, OracleResult>`; `function isOurDefect(verdict: Verdict): boolean`.

The container is invoked exactly as `tools/roxen-lab/README.md` documents: the tree is mounted read-only at `/corpus`, and `oracle --json` prints one JSON object per line with `file`, `verdict`, and optionally `detail`.

- [ ] **Step 1: Write the failing test**

Create `tests/tooling/lsp-audit-oracle.test.ts`:

```ts
import { test, expect } from "bun:test";
import { isOurDefect, parseOracleOutput } from "../../tools/lsp-audit/oracle";

test("ok and semantic mean the source is valid, so the defect is ours", () => {
  expect(isOurDefect("ok")).toBe(true);
  expect(isOurDefect("semantic")).toBe(true);
  expect(isOurDefect("cpp_error")).toBe(true);
});

test("syntax means Pike rejects it too, so it is not our defect", () => {
  expect(isOurDefect("syntax")).toBe(false);
});

test("an unavailable oracle never asserts a defect either way", () => {
  expect(isOurDefect("unavailable")).toBe(false);
  expect(isOurDefect("unreadable")).toBe(false);
});

test("parses one JSON object per line, keyed by corpus-relative path", () => {
  const stdout = [
    '{"file":"/corpus/server/modules/tags/rxmltags.pike","verdict":"semantic","diagnostics":[]}',
    '{"file":"/corpus/server/base_server/roxen.pike","verdict":"ok","diagnostics":[]}',
    "",
  ].join("\n");

  const parsed = parseOracleOutput(stdout);
  expect(parsed.get("server/modules/tags/rxmltags.pike")?.verdict).toBe("semantic");
  expect(parsed.get("server/base_server/roxen.pike")?.verdict).toBe("ok");
});

test("ignores non-JSON noise on stdout", () => {
  const parsed = parseOracleOutput('warning: something\n{"file":"/corpus/a.pike","verdict":"ok"}\n');
  expect(parsed.size).toBe(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tooling/lsp-audit-oracle.test.ts`
Expected: FAIL — cannot resolve `../../tools/lsp-audit/oracle`.

- [ ] **Step 3: Write minimal implementation**

Create `tools/lsp-audit/oracle.ts`:

```ts
/**
 * Oracle gate: ask Pike whether a Roxen file is valid before we call our
 * behaviour on it a defect.
 *
 * Roxen contains source that no correct tool accepts. Without this gate a
 * Roxen-driven audit produces a findings list padded with non-defects. The
 * verdict, not the error count, is what triage reads — see
 * tools/roxen-lab/README.md.
 */

import { execFileSync } from "node:child_process";

export type Verdict = "ok" | "semantic" | "cpp_error" | "syntax" | "unreadable" | "unavailable";

export interface OracleResult {
  file: string;
  verdict: Verdict;
  detail?: string;
}

const IMAGE = "pike-lsp/roxen-lab:6.1";
/** Files per docker run. One container start per file would dominate runtime. */
const BATCH = 40;

/** True when a bad result on this file is our bug rather than invalid source. */
export function isOurDefect(verdict: Verdict): boolean {
  return verdict === "ok" || verdict === "semantic" || verdict === "cpp_error";
}

export function oracleAvailable(): boolean {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Parse `oracle --json` output into corpus-relative path → result. */
export function parseOracleOutput(stdout: string): Map<string, OracleResult> {
  const results = new Map<string, OracleResult>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as { file: string; verdict: Verdict; detail?: string };
      const relative = parsed.file.replace(/^\/corpus\//, "");
      results.set(relative, { file: relative, verdict: parsed.verdict, detail: parsed.detail });
    } catch {
      // Not a result line.
    }
  }
  return results;
}

/**
 * Classify files (paths relative to `roxenRoot`) by compiling them with Pike
 * inside the lab container.
 *
 * When Docker or the image is missing every file comes back "unavailable";
 * triage marks those findings unclassified rather than guessing.
 */
export function classify(relativeFiles: string[], roxenRoot: string): Map<string, OracleResult> {
  const results = new Map<string, OracleResult>();
  if (!oracleAvailable()) {
    for (const file of relativeFiles) {
      results.set(file, { file, verdict: "unavailable" });
    }
    return results;
  }

  for (let i = 0; i < relativeFiles.length; i += BATCH) {
    const batch = relativeFiles.slice(i, i + BATCH);
    const args = [
      "run", "--rm",
      "-v", `${roxenRoot}:/corpus:ro`,
      IMAGE, "oracle", "--json",
      ...batch.map((f) => `/corpus/${f}`),
    ];
    let stdout = "";
    try {
      stdout = execFileSync("docker", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      // oracle.pike exits non-zero when any file fails to compile, which is
      // the normal case here. Its stdout is still the answer.
      stdout = (error as { stdout?: string }).stdout ?? "";
    }
    for (const [path, result] of parseOracleOutput(stdout)) {
      results.set(path, result);
    }
  }

  for (const file of relativeFiles) {
    if (!results.has(file)) results.set(file, { file, verdict: "unreadable" });
  }
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/tooling/lsp-audit-oracle.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify against the real container**

Run:
```bash
bun -e 'import {classify} from "./tools/lsp-audit/oracle.ts";
console.log(classify(["server/base_server/roxen.pike"], "/tank/projects/roxen-6.1"));'
```
Expected: a `Map` with one entry whose verdict is one of `ok`, `semantic`, `cpp_error`, `syntax`. If it is `unavailable`, the image is missing — build it per `tools/roxen-lab/README.md` before Task 9.

- [ ] **Step 6: Commit**

```bash
PRE_COMMIT_ALLOW_NO_CONFIG=1 git add tools/lsp-audit/oracle.ts tests/tooling/lsp-audit-oracle.test.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "feat(audit): add Pike oracle gate for Roxen-tier findings"
```

---

### Task 6: Tier-2 correctness expectations

**Files:**
- Create: `tools/lsp-audit/expectations.ts`
- Test: `tests/tooling/lsp-audit-expectations.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface Expectation { file: string; line: number; character: number; method: string; expect: { kind: "definitionAt"; file: string; line: number } | { kind: "hoverContains"; text: string } | { kind: "referenceCount"; count: number } | { kind: "renameAllowed"; allowed: boolean } | { kind: "completionIncludes"; label: string } }`; `const EXPECTATIONS: Expectation[]`; `function checkExpectation(exp: Expectation, result: unknown): boolean`.

Read the spec amendment above. This covers five capabilities across ten corpus files, not the whole corpus.

- [ ] **Step 1: Read the ten files and record their ground truth**

These ten are chosen; they exist and span the cases that matter. Read each one:

```bash
for f in cross-lib-consumer.pike cross-lib-base.pike cross-inherit-simple-a.pike \
         class-single-inherit.pike class-create.pike class-this-object.pike \
         cross-stdlib.pike cross-import-b.pike class-multi-inherit.pike \
         cross-inherit-chain-a.pike; do
  echo "=== $f ==="; cat -n "corpus/files/$f"; done
```

For each, note the exact line and column of one unambiguous symbol and what each of the five methods must answer for it. **Positions in `EXPECTATIONS` are 0-based** (LSP), while `cat -n` prints 1-based lines — subtract one. Columns are UTF-16 code units, which for these ASCII files equals the character count.

Aim for roughly two expectations per file, covering all five methods across the set. Do not attempt all five on every file.

**Make each assertion discriminating.** A `hoverContains` of `"string"` passes even if hover resolved to a completely different symbol, because almost every hover in these files mentions `string` — it spends a tier-2 slot on something that cannot fail. Assert the declaration, not the type keyword: `"string get_prefix"` rather than `"string"`. The same applies to `referenceCount` — only assert a count you have recounted and believe is unambiguous within the queried file.

- [ ] **Step 2: Write the failing test**

Create `tests/tooling/lsp-audit-expectations.test.ts`:

```ts
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  EXPECTATIONS,
  checkExpectation,
  expectationPositions,
} from "../../tools/lsp-audit/expectations";

test("covers the five tier-2 capabilities", () => {
  const methods = new Set(EXPECTATIONS.map((e) => e.method));
  expect(methods).toContain("textDocument/definition");
  expect(methods).toContain("textDocument/hover");
  expect(methods).toContain("textDocument/references");
  expect(methods).toContain("textDocument/prepareRename");
  expect(methods).toContain("textDocument/completion");
});

test("names ten distinct corpus files, all of which exist", () => {
  const files = new Set(EXPECTATIONS.map((e) => e.file));
  expect(files.size).toBe(10);
  for (const file of files) {
    expect(existsSync(join("corpus/files", file))).toBe(true);
  }
});

test("checkExpectation matches a definition landing on the right line", () => {
  const exp = EXPECTATIONS.find((e) => e.expect.kind === "definitionAt")!;
  const target = exp.expect as { kind: "definitionAt"; file: string; line: number };
  const good = [{ uri: `file:///corpus/files/${target.file}`, range: { start: { line: target.line } } }];
  const bad = [{ uri: `file:///corpus/files/${target.file}`, range: { start: { line: target.line + 99 } } }];
  expect(checkExpectation(exp, good)).toBe(true);
  expect(checkExpectation(exp, bad)).toBe(false);
});

test("checkExpectation treats a missing result as a failure", () => {
  const notRename = EXPECTATIONS.find((e) => e.expect.kind !== "renameAllowed")!;
  expect(checkExpectation(notRename, null)).toBe(false);
});

test("a null prepareRename is the CORRECT answer when rename is disallowed", () => {
  // null is precisely what the server returns for a non-renameable position.
  // If the null guard ran first, `allowed: false` could never pass and would
  // report "wrong" exactly when the server behaved correctly.
  const disallowed = EXPECTATIONS.find(
    (e) => e.expect.kind === "renameAllowed" && e.expect.allowed === false,
  );
  if (!disallowed) return; // no such expectation in the set
  expect(checkExpectation(disallowed, null)).toBe(true);
  expect(checkExpectation(disallowed, { range: {} })).toBe(false);
});

test("every expectation position is exported for the sweep to visit", () => {
  // Without this the sweep only visits TOP-LEVEL documentSymbol names, which
  // reaches 1 of 20 expectations — fields, locals and class members are never
  // emitted as top-level symbols, so tier 2 would check almost nothing.
  const positions = expectationPositions();
  const total = [...positions.values()].reduce((n, list) => n + list.length, 0);
  expect(total).toBe(EXPECTATIONS.length);
  for (const e of EXPECTATIONS) {
    const forFile = positions.get(e.file) ?? [];
    expect(forFile.some((p) => p.line === e.line && p.character === e.character)).toBe(true);
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test tests/tooling/lsp-audit-expectations.test.ts`
Expected: FAIL — cannot resolve `../../tools/lsp-audit/expectations`.

- [ ] **Step 4: Write the implementation**

Create `tools/lsp-audit/expectations.ts`. The `EXPECTATIONS` array below is a worked example of the required shape — **replace every entry with the real positions and answers recorded in Step 1.** Do not ship the placeholder values.

```ts
/**
 * Tier-2 correctness expectations.
 *
 * Tiers 0, 1 and 3 need no ground truth: a crash, an empty result where one is
 * mandatory, and a slow response are all self-evident. Tier 2 — "answered, but
 * wrongly" — needs a known-correct answer, so it is scoped to a curated subset
 * of the corpus where the right answer is unambiguous.
 */

export type ExpectedResult =
  | { kind: "definitionAt"; file: string; line: number }
  | { kind: "hoverContains"; text: string }
  | { kind: "referenceCount"; count: number }
  | { kind: "renameAllowed"; allowed: boolean }
  | { kind: "completionIncludes"; label: string };

export interface Expectation {
  /** Path relative to corpus/files. */
  file: string;
  /** 0-based LSP coordinates. */
  line: number;
  character: number;
  method: string;
  expect: ExpectedResult;
}

export const EXPECTATIONS: Expectation[] = [
  // REPLACE ALL of these with the real positions recorded in Step 1. The two
  // below show the shape only; the line/character values are not real. Ten
  // distinct files are required, and the test in this task enforces that.
  {
    file: "cross-lib-consumer.pike",
    line: 4,
    character: 10,
    method: "textDocument/definition",
    expect: { kind: "definitionAt", file: "cross-lib-base.pike", line: 2 },
  },
  {
    file: "class-single-inherit.pike",
    line: 6,
    character: 8,
    method: "textDocument/hover",
    expect: { kind: "hoverContains", text: "int" },
  },
];

/**
 * Every position an expectation targets, keyed by corpus-relative filename.
 *
 * Fed to the sweep as `extraPositions`. Without it the sweep only visits
 * positions named by TOP-LEVEL documentSymbol entries, which reaches 1 of 20
 * expectations — fields, locals and class members are never emitted as
 * top-level symbols, so tier 2 would check almost nothing.
 */
export function expectationPositions(): Map<string, Array<{ line: number; character: number }>> {
  const byFile = new Map<string, Array<{ line: number; character: number }>>();
  for (const e of EXPECTATIONS) {
    const list = byFile.get(e.file) ?? [];
    list.push({ line: e.line, character: e.character });
    byFile.set(e.file, list);
  }
  return byFile;
}

/**
 * Adapt the expectation set to the sweep's CorrectnessChecker interface.
 *
 * Returns null when nothing covers this (file, method, position) — the common
 * case — so the sweep falls back to the capability's own validator.
 */
export function expectationChecker() {
  const index = new Map<string, Expectation>();
  for (const e of EXPECTATIONS) {
    index.set(`${e.file}|${e.method}|${e.line}:${e.character}`, e);
  }
  return (
    file: string,
    method: string,
    position: { line: number; character: number } | null,
    result: unknown,
  ): boolean | null => {
    if (!position) return null;
    const found = index.get(`${file}|${method}|${position.line}:${position.character}`);
    return found ? checkExpectation(found, result) : null;
  };
}

export function checkExpectation(expectation: Expectation, result: unknown): boolean {
  const want = expectation.expect;

  // renameAllowed is checked BEFORE the null guard, because null is precisely
  // the correct prepareRename response for a non-renameable position. Guarding
  // first would make `allowed: false` unsatisfiable — it would report "wrong"
  // exactly when the server behaves correctly.
  if (want.kind === "renameAllowed") {
    return (result !== null && result !== undefined) === want.allowed;
  }
  if (result === null || result === undefined) return false;

  switch (want.kind) {
    case "definitionAt": {
      const locations = Array.isArray(result) ? result : [result];
      return locations.some((loc: { uri?: string; range?: { start?: { line: number } } }) =>
        loc.uri?.endsWith(want.file) && loc.range?.start?.line === want.line,
      );
    }
    case "hoverContains": {
      const contents = (result as { contents?: { value?: string } }).contents;
      return typeof contents?.value === "string" && contents.value.includes(want.text);
    }
    case "referenceCount":
      return Array.isArray(result) && result.length === want.count;
    case "renameAllowed":
      return true; // Handled before the null guard above; unreachable here.
    case "completionIncludes": {
      const items = Array.isArray(result) ? result : (result as { items?: unknown[] }).items ?? [];
      return items.some((item: { label?: string }) => item.label === want.label);
    }
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/tooling/lsp-audit-expectations.test.ts`
Expected: PASS, 4 tests. The "ten distinct files" test fails until Step 1's real entries replace the example — that is the intended forcing function.

- [ ] **Step 6: Commit**

```bash
PRE_COMMIT_ALLOW_NO_CONFIG=1 git add tools/lsp-audit/expectations.ts tests/tooling/lsp-audit-expectations.test.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "feat(audit): add tier-2 correctness expectations for the corpus subset"
```

---

### Task 7: Triage

**Files:**
- Create: `tools/lsp-audit/triage.ts`
- Test: `tests/tooling/lsp-audit-triage.test.ts`

**Interfaces:**
- Consumes: `LedgerRecord`, `Tier` (Task 1); `OracleResult`, `Verdict`, `isOurDefect` (Task 5).
- Produces: `type Severity = "Critical" | "High" | "Medium" | "Low"`; `interface Finding { id: string; severity: Severity; tier: Tier; surface: string; capability: string; file: string; position: { line: number; character: number } | null; summary: string; reproduction: string; oracleVerdict?: Verdict }`; `interface TriageOptions { slowMs?: number; verdicts?: Map<string, OracleResult>; roxenWorkspace?: string }`; `function triage(records: LedgerRecord[], options?: TriageOptions): Finding[]`; `function renderFindings(findings: Finding[]): string`.

- [ ] **Step 1: Write the failing test**

Create `tests/tooling/lsp-audit-triage.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/tooling/lsp-audit-triage.test.ts`
Expected: FAIL — cannot resolve `../../tools/lsp-audit/triage`.

- [ ] **Step 3: Write minimal implementation**

Create `tools/lsp-audit/triage.ts`:

```ts
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
```

- [ ] **Step 4: Add the tier-2 and unavailable-verdict cases to the test**

Append to `tests/tooling/lsp-audit-triage.test.ts`:

```ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/tooling/lsp-audit-triage.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
PRE_COMMIT_ALLOW_NO_CONFIG=1 git add tools/lsp-audit/triage.ts tests/tooling/lsp-audit-triage.test.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "feat(audit): add tier-based triage and markdown renderer"
```

---

### Task 8: CLI and corpus calibration

**Files:**
- Create: `tools/lsp-audit/cli.ts`
- Modify: `package.json` (add `audit:sweep` and `audit:triage` scripts)

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: two commands — `bun run tools/lsp-audit/cli.ts sweep --workspace <corpus|roxen> --out <ledger.jsonl>` and `bun run tools/lsp-audit/cli.ts triage --ledger <path> --out <markdown>`.

**This task is the credibility gate.** The corpus tier runs first, on files known to be handled correctly. Findings here are presumed to be harness bugs until proven otherwise. Do not proceed to Task 9 until this passes.

- [ ] **Step 1: Write the CLI**

Create `tools/lsp-audit/cli.ts`:

```ts
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
import { Ledger, readLedger } from "./ledger";
import { runSweep } from "./sweep";
import { classify } from "./oracle";
import { expectationChecker, expectationPositions } from "./expectations";
import { triage, renderFindings } from "./triage";

const CORPUS_ROOT = resolve("corpus/files");
const ROXEN_ROOT = process.env.ROXEN_HOME ?? "/tank/projects/roxen-6.1";

function pikeFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(pike|pmod)$/.test(entry)) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

function flag(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
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

function triageCommand(): void {
  const records = readLedger(flag("ledger"));
  const roxenRecords = records.filter((r) => r.workspace === "roxen-6.1");
  const suspicious = [...new Set(
    roxenRecords.filter((r) => r.status !== "ok").map((r) => r.file),
  )];
  const verdicts = suspicious.length > 0 ? classify(suspicious, ROXEN_ROOT) : new Map();

  const findings = triage(records, { verdicts, roxenWorkspace: "roxen-6.1" });
  writeFileSync(flag("out"), renderFindings(findings) + "\n");
  console.error(`${findings.length} findings from ${records.length} records`);
}

const command = process.argv[2];
if (command === "sweep") await sweepCommand();
else if (command === "triage") triageCommand();
else {
  console.error("usage: cli.ts sweep --workspace <corpus|roxen> --out <path>");
  console.error("       cli.ts triage --ledger <path> --out <path>");
  process.exit(2);
}
```

- [ ] **Step 2: Add the package scripts**

In `package.json`, after the `"probe"` line, add:

```json
    "audit:sweep": "bun run tools/lsp-audit/cli.ts sweep",
    "audit:triage": "bun run tools/lsp-audit/cli.ts triage",
```

- [ ] **Step 3: Run the corpus sweep**

```bash
mkdir -p /tmp/lsp-audit
bun run audit:sweep -- --workspace corpus --out /tmp/lsp-audit/corpus.jsonl
```
Expected: completes without throwing; prints the file count. Roughly 80 files.

- [ ] **Step 4: Triage the corpus ledger**

```bash
bun run audit:triage -- --ledger /tmp/lsp-audit/corpus.jsonl --out /tmp/lsp-audit/corpus-findings.md
cat /tmp/lsp-audit/corpus-findings.md
```

- [ ] **Step 5: Calibrate — this is the gate**

For each of the first ten findings, run its `Reproduction` command by hand and record what happens:

```bash
# Example, using the actual command from the findings table:
bun run scripts/lsp-probe.ts hover corpus/files/basic-int-ranges.pike 3:7
```

Classify each:
- **Reproduces** → a real finding. Keep.
- **Does not reproduce** → a harness bug. Fix `matrix.ts` (usually a validator treating a legal empty result as `empty`) or `positions.ts` (a position landing on whitespace or inside a string), then re-run Steps 3–4.

Repeat until every sampled finding reproduces by hand. A validator that flags legal-empty results is the most likely defect: `textDocument/typeDefinition` on an `int` correctly returns nothing.

- [ ] **Step 6: Commit**

```bash
PRE_COMMIT_ALLOW_NO_CONFIG=1 git add tools/lsp-audit/cli.ts package.json
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "feat(audit): add sweep/triage CLI and calibrate on the corpus tier"
```

---

### Task 9: Roxen tier run

**Files:**
- Create: `/tmp/lsp-audit/roxen.jsonl` (not committed — a build artifact)

**Interfaces:**
- Consumes: the calibrated CLI from Task 8.
- Produces: a triaged Roxen findings table for Task 12.

Do not start this until Task 8's calibration gate passes. An uncalibrated harness over 448 files produces a findings list nobody can act on.

- [ ] **Step 1: Confirm the tree and image are present**

```bash
ls /tank/projects/roxen-6.1/server/base_server/roxen.pike
docker image inspect pike-lsp/roxen-lab:6.1 --format '{{.Id}}'
```
Expected: both succeed. If the image is missing, build it per `tools/roxen-lab/README.md` (10–20 minutes).

- [ ] **Step 2: Run the sweep**

```bash
bun run audit:sweep -- --workspace roxen --out /tmp/lsp-audit/roxen.jsonl
```
Expected: tens of minutes over ~448 files. If it dies partway, the ledger holds everything up to that point — record the crash itself as a Critical finding, then re-run.

- [ ] **Step 3: Triage with the oracle gate**

```bash
bun run audit:triage -- --ledger /tmp/lsp-audit/roxen.jsonl --out /tmp/lsp-audit/roxen-findings.md
```
Expected: every Roxen finding carries an `oracle:` marker. Any marked `unavailable` means Docker failed — fix that and re-triage rather than shipping unclassified findings.

- [ ] **Step 4: Check the memory trace**

```bash
bun -e 'import {readLedger} from "./tools/lsp-audit/ledger.ts";
const r = readLedger("/tmp/lsp-audit/roxen.jsonl");
const peak = Math.max(...r.map(x => x.rssBytes));
console.log("peak RSS", (peak / 1024 / 1024).toFixed(0), "MB over", r.length, "records");'
```
Record the peak. Compare against the heap cap the memory governor enforces; a peak at or above it belongs in the report as a finding.

- [ ] **Step 5: Spot-check ten Roxen findings by hand**

Same procedure as Task 8 Step 5, using each finding's reproduction command. Findings that do not reproduce are harness bugs, not Roxen bugs — fix and re-run before writing them up.

- [ ] **Step 6: Commit nothing, but save the findings**

```bash
cp /tmp/lsp-audit/roxen-findings.md /tmp/lsp-audit/roxen-findings-verified.md
```
The ledgers stay out of git; the findings land in `iteration-7.md` in Task 12.

---

### Task 10: Standalone stdio sweep (Surface 4)

**Files:**
- Create: `tools/lsp-audit/standalone-sweep.mjs`
- Modify: `package.json` (add `audit:standalone`)

**Interfaces:**
- Consumes: nothing from the TypeScript units — this runs against a built bundle over real stdio, deliberately sharing no code with the in-process sweep.
- Produces: a pass/fail report per capability, printed to stdout.

**Why not reuse `sweep.ts`.** The point of this surface is to catch VSCode-only assumptions. Booting the server in-process through `createTestServer` cannot catch them, because it never crosses a real stdio boundary or negotiates with a non-VSCode client. This follows the existing pattern in `scripts/check-helix-lsp.mjs` — read that file first; it already solves the framing and handshake.

- [ ] **Step 1: Read the existing pattern**

```bash
cat scripts/check-helix-lsp.mjs
```
Note how it spawns the bundle, frames Content-Length messages, and advertises capabilities. Reuse that structure.

- [ ] **Step 2: Build the standalone bundle**

```bash
bun run build:standalone
```
Expected: `standalone/server.js` exists.

- [ ] **Step 3: Write the sweep**

First extract the shared framing helpers, then write the driver.

**Step 3a — extract `tools/lsp-audit/lsp-stdio.mjs`.** Move `send`, `notify`, and the Content-Length receive loop out of `scripts/check-helix-lsp.mjs` into this new module, exporting them unchanged. Then update `scripts/check-helix-lsp.mjs` to import them instead of defining them. Do not alter their behaviour — this is a move, not a rewrite.

Verify the guard still works before going further:

```bash
bun run build:standalone && bun run check:helix
```
Expected: same result as before the extraction. `check:helix` is part of the repository-guards CI job, so a regression here breaks CI.

**Step 3b — write the driver.** Create `tools/lsp-audit/standalone-sweep.mjs`, importing `send` and `notify` from `./lsp-stdio.mjs`:

```js
#!/usr/bin/env node
/**
 * Surface 4: sweep every capability over real stdio as a non-VSCode client.
 *
 * Deliberately shares no code with tools/lsp-audit/sweep.ts. That sweep boots
 * the server in-process, so it can never cross a real stdio boundary or
 * negotiate with a client that is not VSCode — which is exactly where
 * VSCode-only assumptions hide.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { send, notify } from "./lsp-stdio.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Symbol names avoid Pike stdlib and predef collisions (`name`, `count`,
// `size`): the rename guard rejects those by name, which would fail this
// sweep for reasons unrelated to the standalone path. See docs/other-editors.md.
const FIXTURE = `class Greeter {
  string label;
  void create(string initial) { label = initial; }
  string speak() { return label + "!"; }
}

int main() {
  Greeter greeter = Greeter("hi");
  write(greeter->speak() + "\\n");
  return 0;
}
`;

// A deliberately minimal client: no hierarchical document symbols, no
// resolveSupport, no snippets. A server that assumes those exist breaks in
// Helix, and that is a finding.
const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { didSave: true },
    hover: { contentFormat: ["markdown", "plaintext"] },
    completion: { completionItem: { snippetSupport: false } },
    documentSymbol: { hierarchicalDocumentSymbolSupport: false },
    semanticTokens: {
      requests: { full: { delta: true }, range: true },
      tokenTypes: [], tokenModifiers: [], formats: ["relative"],
    },
  },
  workspace: { workspaceEdit: { documentChanges: true } },
};

// Every method the in-process matrix sweeps, with params valid at 8:12 —
// inside `greeter->speak()` on the write() line.
const POSITION = { line: 8, character: 12 };
const REQUESTS = (uri) => [
  ["textDocument/hover", { textDocument: { uri }, position: POSITION }],
  ["textDocument/definition", { textDocument: { uri }, position: POSITION }],
  ["textDocument/declaration", { textDocument: { uri }, position: POSITION }],
  ["textDocument/typeDefinition", { textDocument: { uri }, position: POSITION }],
  ["textDocument/implementation", { textDocument: { uri }, position: POSITION }],
  ["textDocument/references", { textDocument: { uri }, position: POSITION, context: { includeDeclaration: true } }],
  ["textDocument/prepareRename", { textDocument: { uri }, position: POSITION }],
  ["textDocument/rename", { textDocument: { uri }, position: POSITION, newName: "auditRenamedSymbol" }],
  ["textDocument/documentHighlight", { textDocument: { uri }, position: POSITION }],
  ["textDocument/signatureHelp", { textDocument: { uri }, position: POSITION, context: { triggerKind: 1, isRetrigger: false } }],
  ["textDocument/selectionRange", { textDocument: { uri }, positions: [POSITION] }],
  ["textDocument/prepareCallHierarchy", { textDocument: { uri }, position: POSITION }],
  ["textDocument/prepareTypeHierarchy", { textDocument: { uri }, position: POSITION }],
  ["textDocument/completion", { textDocument: { uri }, position: POSITION, context: { triggerKind: 1 } }],
  ["textDocument/documentSymbol", { textDocument: { uri } }],
  ["textDocument/semanticTokens/full", { textDocument: { uri } }],
  ["textDocument/foldingRange", { textDocument: { uri } }],
  ["textDocument/documentLink", { textDocument: { uri } }],
  ["textDocument/codeLens", { textDocument: { uri } }],
  ["textDocument/formatting", { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } }],
  ["textDocument/rangeFormatting", { textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } }, options: { tabSize: 2, insertSpaces: true } }],
  ["workspace/symbol", { query: "Greeter" }],
];

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "pike-standalone-sweep-"));
  const file = join(dir, "greeter.pike");
  writeFileSync(file, FIXTURE);
  const uri = `file://${file}`;

  const proc = spawn("bun", [`${ROOT}/standalone/server.js`, "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  await send(proc, "initialize", {
    processId: process.pid,
    rootUri: `file://${dir}`,
    capabilities: CLIENT_CAPABILITIES,
    // The standalone contract: configuration arrives ONLY here. A capability
    // that needs workspace/configuration to work is a finding.
    initializationOptions: { pike: { diagnostics: { enable: true } } },
  });
  notify(proc, "initialized", {});
  notify(proc, "textDocument/didOpen", {
    textDocument: { uri, languageId: "pike", version: 1, text: FIXTURE },
  });

  let failures = 0;
  for (const [method, params] of REQUESTS(uri)) {
    try {
      const result = await send(proc, method, params, 10_000);
      const empty = result === null || (Array.isArray(result) && result.length === 0);
      console.log(`${empty ? "empty" : "ok"}\t${method}`);
      if (empty) failures++;
    } catch (error) {
      console.log(`error\t${method}\t${error.message}`);
      failures++;
    }
  }

  proc.kill();
  console.error(`${failures} capabilities did not answer over stdio`);
  process.exit(failures > 0 ? 1 : 0);
}

await main();
```

Note that `empty` is reported, not treated as automatically fatal — `typeDefinition` on a class instance may legitimately return nothing. Task 12 decides which empties are findings; this script only records them.

- [ ] **Step 4: Add the package script**

In `package.json`, next to `audit:triage`:

```json
    "audit:standalone": "node tools/lsp-audit/standalone-sweep.mjs",
```

- [ ] **Step 5: Run it**

```bash
bun run audit:standalone
```
Expected: a line per capability. Every `error` and every `empty` on a capability that must answer is a finding for Task 12 — these are the VSCode-only assumptions.

- [ ] **Step 6: Commit**

```bash
PRE_COMMIT_ALLOW_NO_CONFIG=1 git add tools/lsp-audit/lsp-stdio.mjs tools/lsp-audit/standalone-sweep.mjs scripts/check-helix-lsp.mjs package.json
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "feat(audit): sweep all capabilities over real stdio as a non-VSCode client"
```

---

### Task 11: Client-layer probe (Surface 3)

**Files:**
- Create: `tests/integration/suite/clientSurface.test.ts`

**Interfaces:**
- Consumes: the VSCode integration test API already used by `tests/integration/suite`.
- Produces: three assertions, each of which is a finding source for Task 12.

- [ ] **Step 1: Read the existing integration pattern**

```bash
ls tests/integration/suite
cat tests/integration/crossFilePropagation.test.ts
```
Follow the same activation and setup shape.

- [ ] **Step 2: Write the test**

Create `tests/integration/suite/clientSurface.test.ts`:

```ts
import * as assert from "node:assert";
import * as vscode from "vscode";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { roxenHome, roxenAvailable } from "../../helpers/roxenAvailable";

const EXTENSION_ID = "pike-language-server";

/** Open a document and give the server time to index it. */
async function openAndSettle(uri: vscode.Uri): Promise<vscode.TextDocument> {
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  await new Promise((r) => setTimeout(r, 3000));
  return doc;
}

suite("client surface", () => {
  // Case 1. Most machines have no Roxen tree — that is the case the feature is
  // designed for, so this skips rather than fails.
  test("activates and produces symbols on a real Roxen module", async function () {
    if (!roxenAvailable) return this.skip();
    const target = vscode.Uri.file(join(roxenHome!, "server", "base_server", "roxen.pike"));
    const doc = await openAndSettle(target);
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      doc.uri,
    );
    assert.ok(symbols && symbols.length > 0, "no symbols from a real Roxen module");
  });

  // Case 2. A setting the server never reads is the same defect class as
  // iteration-6's `builtinFunction`: declared in the manifest, never used.
  test("every contributed setting is readable through the configuration API", async () => {
    const manifest = JSON.parse(readFileSync("extension.package.json", "utf8"));
    const properties = manifest.contributes?.configuration?.properties ?? {};
    const unreadable: string[] = [];
    for (const key of Object.keys(properties)) {
      const [section, ...rest] = key.split(".");
      const value = vscode.workspace.getConfiguration(section).get(rest.join("."));
      if (value === undefined) unreadable.push(key);
    }
    assert.deepStrictEqual(unreadable, [], `settings with no reachable value: ${unreadable}`);
  });

  // Case 3. Disagreement between the two highlight layers is what produces
  // visibly wrong colours in the editor.
  test("semantic tokens do not contradict the grammar on comments", async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: "pike",
      content: "// a comment\nint counter = 1;\n",
    });
    await vscode.window.showTextDocument(doc);
    await new Promise((r) => setTimeout(r, 2000));

    const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>(
      "vscode.provideDocumentSemanticTokens",
      doc.uri,
    );
    // The first token must not start on line 0, which is entirely a comment.
    if (tokens && tokens.data.length >= 5) {
      assert.notStrictEqual(tokens.data[0], 0, "a semantic token was emitted inside a comment line");
    }
  });
});
```

If `extension.package.json` is not at the integration test's working directory, resolve it from the workspace root the same way the neighbouring tests in `tests/integration/suite` do.

- [ ] **Step 3: Run it**

```bash
bun run test:integration
```
Expected: three cases run (case 1 skips without a Roxen tree). Record every failure for Task 12.

- [ ] **Step 4: Commit**

```bash
PRE_COMMIT_ALLOW_NO_CONFIG=1 git add tests/integration/suite/clientSurface.test.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "test(audit): probe activation, settings plumbing and grammar agreement"
```

---

### Task 12: Stage C code read and the report

**Files:**
- Create: `docs/audits/iteration-7.md`
- Modify: `docs/audits/README.md` (add the iteration-7 row)

**Interfaces:**
- Consumes: verified findings from Tasks 8, 9, 10, 11.
- Produces: the audit deliverable.

- [ ] **Step 1: Read the modules the sweep flagged**

For each distinct `capability` appearing in the verified findings, open its implementation under `server/src/features/` and find the cause behind the symptom. A finding that says "hover returned nothing at `foo.pike:12`" becomes useful only when it says why.

- [ ] **Step 2: Read the surfaces the sweep cannot reach**

Four reads, each producing findings in the iteration-6 style:

- `client/syntaxes/pike.tmLanguage.json` — patterns that never match, and constructs with no pattern at all.
- `client/language-configuration.json` — bracket pairs, comment continuation, indentation rules.
- `client/src/extension.ts` — activation events, and whether every event actually has a handler.
- `extension.package.json` — every `contributes.configuration` key, cross-checked against whether the server reads it. Task 11 case 2 automates part of this; the read catches what it misses.

- [ ] **Step 3: Write the report**

Create `docs/audits/iteration-7.md` following the iteration-6 structure exactly: title, date, scope, a Finding Summary table counting by severity, then one section per area (Server LSP, Roxen layer, Client layer, Standalone) each with **Architecture**, a **Findings** table, and **What Works Well**.

Every finding row must carry its reproduction command. Every Roxen-tier row must carry its oracle verdict.

Header:

```markdown
# Audit Iteration 7 — Full LSP Feature Audit

Date: 2026-07-30

Scope: Behavioural sweep of all 26 declared capabilities across four surfaces
(server, Roxen layer, extension client, standalone stdio), oracle-gated against
Pike, followed by a code read of the flagged modules and the surfaces the sweep
cannot reach.
```

- [ ] **Step 4: Update the index**

In `docs/audits/README.md`, add a row to the table:

```markdown
| [7](iteration-7.md) | 2026-07-30 | Behavioural, all four surfaces | Complete — N findings (aC/bH/cM/dL) |
```

Replace `N` and the counts with the real numbers.

- [ ] **Step 5: Verify the whole suite is still green**

```bash
bun test
bun run typecheck
```
Expected: green. The audit added tests; it must not have broken any.

- [ ] **Step 6: Commit**

```bash
PRE_COMMIT_ALLOW_NO_CONFIG=1 git add docs/audits/iteration-7.md docs/audits/README.md
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "docs: add audit iteration 7 — full LSP feature audit"
```

---

## Verification

The audit is complete when all of the following hold — these are the design doc's success criteria, made checkable:

- [ ] `bun test tests/tooling/lsp-audit-*.test.ts` passes.
- [ ] `bun run typecheck` passes.
- [ ] The matrix coverage test passes, proving all 26 declared capabilities are swept.
- [ ] A corpus ledger and a Roxen ledger both exist, with records for every capability.
- [ ] Every finding in `iteration-7.md` carries a reproduction command that was run by hand.
- [ ] Every Roxen-tier finding carries an oracle verdict, none of them `unavailable`.
- [ ] All four surfaces have a section in `iteration-7.md`.
- [ ] `docs/audits/README.md` has the iteration-7 row.
- [ ] No CI workflow file was modified.
