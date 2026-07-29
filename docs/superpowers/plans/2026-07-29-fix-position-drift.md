# Fix Position Drift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the UTF-8↔UTF-16 conversion layer that shifts every LSP range on a line containing non-ASCII characters, and decode Pike source by its actual encoding instead of assuming UTF-8.

**Architecture:** `web-tree-sitter` 0.26 indexes JS-string input in UTF-16 code units — the same unit LSP requires — so the correct transform between a tree-sitter position and an LSP position is the identity. Two util modules implement the opposite belief (`positionConverter.ts` converts; `offsetMap.ts` makes that conversion fast). Both are deleted so that every one of the 51 call sites becomes a compile error rather than a silent wrong answer. Separately, source is decoded by sniffing `#charset` → UTF-8 → ISO-8859-1 rather than forcing UTF-8.

**Tech Stack:** TypeScript, Bun test runner, `web-tree-sitter` 0.26, `vscode-languageserver`.

## Global Constraints

- Files ≤500 lines, functions ≤50 lines (quality gates).
- Conventional commit types only. No AI/Claude attribution anywhere.
- Default test run is serial: `bun test`. `test:fast` is opt-in parallel.
- The suite is **green**: measured baseline `2280 pass / 2 skip / 0 fail` across 98 files. Any failure this change introduces is a regression, full stop. (An earlier draft of this plan claimed a known-red baseline; that was stale and was corrected by measurement in Task 1.)
- `bun run typecheck` must exit clean at every task boundary. Task 3 uses it as the proof that no call site was missed, so an unrelated typecheck error would mask a real defect.
- `PRE_COMMIT_ALLOW_NO_CONFIG=1` must prefix `git commit`.
- Server-owned JSON (caches, manifests, `pike.json`) stays UTF-8. Encoding detection applies only to Pike source.

---

### Task 1: Baseline and binding contract

Establishes what "no regression" means, and locks the library semantics the whole change depends on.

**Files:**
- Create: `tests/lsp/treeSitterUnits.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a recorded pre-existing failure baseline (a number, written into the commit message) for Tasks 6–7 to compare against.

- [ ] **Step 1: Capture the pre-existing failure baseline**

Run: `bun test 2>&1 | tail -20`

Record the pass/fail counts. The suite is known-red; this number is the comparison point for the rest of the plan. Do not attempt to fix unrelated failures.

- [ ] **Step 2: Write the binding-semantics test**

Create `tests/lsp/treeSitterUnits.test.ts`:

```typescript
/**
 * Parser binding unit contract.
 *
 * web-tree-sitter indexes JS-string input in UTF-16 code units, which is the
 * unit LSP requires. The server therefore passes tree-sitter positions through
 * unconverted. If an upgrade changes this to UTF-8 bytes, every position the
 * server emits silently drifts — so assert it here rather than trusting it.
 */

import { test, expect, describe } from "bun:test";
import { Parser, Language } from "web-tree-sitter";
import { resolve } from "node:path";

const WASM = resolve(import.meta.dir, "../../server/tree-sitter-pike.wasm");

describe("web-tree-sitter index units", () => {
  test("columns are UTF-16 code units, not UTF-8 bytes", async () => {
    await Parser.init();
    const parser = new Parser();
    parser.setLanguage(await Language.load(WASM));

    // "© © " — two 2-byte UTF-8 characters, one UTF-16 code unit each.
    const line = "int x; // © © marker";
    const utf16Length = line.length;                              // 20
    const utf8Length = new TextEncoder().encode(line).byteLength; // 22
    expect(utf16Length).not.toBe(utf8Length); // the fixture must discriminate

    const tree = parser.parse(line + "\n")!;
    const comment = tree.rootNode.descendantForPosition({ row: 0, column: 7 });

    expect(comment.type).toBe("comment");
    expect(comment.startPosition.column).toBe(7);
    expect(comment.endPosition.column).toBe(utf16Length);
    expect(comment.endPosition.column).not.toBe(utf8Length);

    tree.delete();
  });

  test("astral-plane characters count as two code units", async () => {
    await Parser.init();
    const parser = new Parser();
    parser.setLanguage(await Language.load(WASM));

    // "😀" is 2 UTF-16 code units and 4 UTF-8 bytes.
    const line = "int x; // 😀 tail";
    const tree = parser.parse(line + "\n")!;
    const comment = tree.rootNode.descendantForPosition({ row: 0, column: 7 });

    expect(comment.endPosition.column).toBe(line.length);
    tree.delete();
  });
});
```

- [ ] **Step 3: Run it — it must pass against the current version**

Run: `bun test tests/lsp/treeSitterUnits.test.ts`
Expected: PASS. This test documents current reality; it is the tripwire for future upgrades, not a failing test.

If it FAILS, stop and report — the premise of this entire plan is wrong and the diagnosis must be redone.

- [ ] **Step 4: Commit**

```bash
git add tests/lsp/treeSitterUnits.test.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "test: assert web-tree-sitter reports UTF-16 code units"
```

---

### Task 2: Failing feature tests that prove the drift

Written before any fix, so the fix is confirmed to remove the drift rather than merely change it.

**The drift is per-line.** `utf8ToUtf16(lines[row], column)` only consults the token's own line, so a non-ASCII character on line 0 cannot affect a token on line 3. Every fixture below therefore puts the non-ASCII character **on the same line, before the token**, inside a block comment. The values in these tests were measured against the current build, not predicted.

**Do not use `textDocument/documentLink` here.** In the in-process test server it returns `[]` for these fixtures — module and include resolution finds nothing without a real workspace on disk — so a link assertion would fail for the wrong reason. (This is also why the existing `tests/lsp/documentLink.test.ts` guards every range assertion behind `if (result.length > 0)` and effectively asserts nothing.)

**Files:**
- Create: `tests/lsp/nonAsciiPositions.test.ts`

**Interfaces:**
- Consumes: `createTestServer` from `tests/lsp/helpers.ts` (existing; `server.openDoc(uri, src)` returns the uri, `server.client.sendRequest(method, params)` issues LSP requests, `server.teardown()` closes).
- Produces: the regression gate for Tasks 3–4.

- [ ] **Step 1: Write the failing tests**

Create `tests/lsp/nonAsciiPositions.test.ts`:

```typescript
/**
 * Non-ASCII position correctness.
 *
 * tree-sitter and LSP both index in UTF-16 code units, so positions must pass
 * through unconverted. While the conversion layer existed, every range shifted
 * LEFT by one per non-ASCII character preceding the token on its own line, and
 * every lookup shifted RIGHT by the same amount — which is why hovering one
 * symbol could return the documentation for a different one.
 *
 * Measured against the pre-fix build:
 *   - "helper" at true index 12 was reported at 11
 *   - "main" at true index 13 (two © before it) was reported at 11
 *   - hovering "alpha" at its true index returned "int beta()"
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestServer, type TestServer } from "./helpers";

interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}
interface Sym { name: string; range: Range; selectionRange: Range }
interface HoverResult { contents: { value: string } | string; range?: Range }
interface LocationResult { uri: string; range: Range }

let server: TestServer;

beforeAll(async () => { server = await createTestServer(); });
afterAll(async () => { await server.teardown(); });

// One © before "helper" on line 0; two © before "main" on line 1.
const OUTBOUND = [
  '/* © */ int helper() { return 1; }',
  '/* ©© */ int main() { return helper(); }',
].join('\n');

// Ten © before the call site, enough that a right-shifted lookup on "alpha"
// lands squarely on "beta".
const INBOUND = [
  'int alpha() { return 1; }',
  'int beta() { return 2; }',
  '/* ©©©©©©©©©© */ int main() { return alpha() + beta(); }',
].join('\n');

describe("outbound ranges are not shifted by non-ASCII on the same line", () => {
  test("declaration ranges match their true UTF-16 indices", async () => {
    const uri = server.openDoc("file:///test/nonascii-outbound.pike", OUTBOUND);

    const syms = await server.client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    }) as Sym[] | null;

    expect(syms).not.toBeNull();

    const lines = OUTBOUND.split('\n');
    const helper = syms!.find(s => s.name === "helper");
    expect(helper).toBeDefined();
    // "/* © */ int helper() ..." — "helper" is at UTF-16 index 12.
    expect(lines[0]!.indexOf("helper")).toBe(12);
    expect(helper!.selectionRange.start.character).toBe(12);
    expect(helper!.selectionRange.end.character).toBe(18);

    const main = syms!.find(s => s.name === "main");
    expect(main).toBeDefined();
    // "/* ©© */ int main() ..." — "main" is at UTF-16 index 13.
    expect(lines[1]!.indexOf("main")).toBe(13);
    expect(main!.selectionRange.start.character).toBe(13);
    expect(main!.selectionRange.end.character).toBe(17);
  });

  test("an ASCII-only control file is unaffected", async () => {
    // Same layout, © replaced by spaces, so indices shift but nothing drifts.
    const control = [
      '/*   */ int helper() { return 1; }',
      '/*    */ int main() { return helper(); }',
    ].join('\n');
    const uri = server.openDoc("file:///test/nonascii-control.pike", control);

    const syms = await server.client.sendRequest("textDocument/documentSymbol", {
      textDocument: { uri },
    }) as Sym[] | null;

    const helper = syms!.find(s => s.name === "helper");
    expect(helper!.selectionRange.start.character).toBe(12);
    const main = syms!.find(s => s.name === "main");
    expect(main!.selectionRange.start.character).toBe(13);
  });
});

describe("inbound lookups resolve the token actually at the position", () => {
  test("hover on a call returns that function, not its neighbour", async () => {
    const uri = server.openDoc("file:///test/nonascii-inbound.pike", INBOUND);
    const line2 = INBOUND.split('\n')[2]!;
    const alphaAt = line2.indexOf("alpha");
    expect(alphaAt).toBe(37); // guard: the fixture must not drift silently

    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: 2, character: alphaAt },
    }) as HoverResult | null;

    expect(hover).not.toBeNull();
    const text = typeof hover!.contents === "string"
      ? hover!.contents
      : hover!.contents.value;
    expect(text).toContain("alpha");
    expect(text).not.toContain("beta"); // pre-fix, this returned "int beta()"
  });

  test("hover on the second call resolves rather than returning null", async () => {
    const uri = server.openDoc("file:///test/nonascii-inbound2.pike", INBOUND);
    const line2 = INBOUND.split('\n')[2]!;
    const betaAt = line2.indexOf("beta");
    expect(betaAt).toBe(47);

    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position: { line: 2, character: betaAt },
    }) as HoverResult | null;

    expect(hover).not.toBeNull(); // pre-fix, the shifted lookup fell off the end
    const text = typeof hover!.contents === "string"
      ? hover!.contents
      : hover!.contents.value;
    expect(text).toContain("beta");
  });

  test("go-to-definition from a shifted call lands on the right declaration", async () => {
    const uri = server.openDoc("file:///test/nonascii-def.pike", INBOUND);
    const line2 = INBOUND.split('\n')[2]!;

    const def = await server.client.sendRequest("textDocument/definition", {
      textDocument: { uri },
      position: { line: 2, character: line2.indexOf("alpha") },
    }) as LocationResult | LocationResult[] | null;

    expect(def).not.toBeNull();
    const loc = Array.isArray(def) ? def[0]! : def!;
    // "int alpha()" is line 0; "alpha" starts at character 4.
    expect(loc.range.start.line).toBe(0);
    expect(loc.range.start.character).toBe(4);
  });
});
```

- [ ] **Step 2: Run to verify they fail — and fail for the stated reason**

Run: `bun test tests/lsp/nonAsciiPositions.test.ts`

Expected: FAIL. The specific pre-fix values, measured on the current build:

| Assertion | Expected | Pre-fix actual |
|---|---|---|
| `helper` selectionRange start | 12 | 11 |
| `main` selectionRange start | 13 | 11 |
| hover on `alpha` | contains "alpha" | `int beta()` |
| hover on `beta` | non-null | `null` |

The ASCII control test should **pass** already — it is the discriminator proving the fixtures differ only in encoding.

If the failures do not match this table, stop and report before changing any source. A different failure mode means the diagnosis needs revisiting.

- [ ] **Step 3: Commit the failing tests**

```bash
git add tests/lsp/nonAsciiPositions.test.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "test: add failing non-ASCII position tests"
```

---

### Task 3: Delete the conversion layer

**Files:**
- Modify (outbound, `utf8ToUtf16` removal): `server/src/features/callHierarchy.ts:269-270`, `accessResolver.ts:408`, `selectionRange.ts:139,143,160,161`, `scope-helpers.ts:52,90,91`, `signatureHelp.ts:164,170,207,331,352`, `completion-items.ts:303,319`, `inlayHints.ts:174`, `diagnostics.ts:20,85`, `documentLink.ts:209,213`, `documentSymbol.ts:23`, `lintRules/unreachableCode.ts:124,125`
- Modify (inbound, `utf16ToUtf8` removal): `server/src/features/hoverHandler.ts:108`, `accessResolver.ts:128`, `selectionRange.ts:98`, `signatureHelp.ts:78`, `completion.ts:74`, `completionTriggerResolve.ts:21,81,140,207,282`, `lintRules/missingReturn.ts:57`
- Modify: `server/src/util/positionConverter.ts` — delete both converters, keep `getLineText`
- Modify: `tests/lsp/positionConverter.test.ts` — drop converter sections, keep `getLineText`

**Interfaces:**
- Consumes: `getLineText(source, line)` stays exported from `positionConverter.ts` (three unrelated consumers).
- Produces: `positionConverter.ts` exporting only `getLineText`.

- [ ] **Step 1: Remove outbound conversions**

Each is the same mechanical shape — the converted column becomes the raw column. For example, `documentLink.ts:205-216` becomes:

```typescript
function toLinkRange(node: Node): LspRange {
  return {
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: node.endPosition.row, character: node.endPosition.column },
  };
}
```

Drop the now-unused `lines` parameter from `toLinkRange` and its call sites in the same file. Apply the same treatment at each outbound site listed above; where removing the conversion leaves a `lines` parameter unused, remove the parameter.

- [ ] **Step 2: Remove inbound conversions**

The LSP character is passed straight to tree-sitter. For example, `hoverHandler.ts:104-115` becomes:

```typescript
  character: number,
): string | null {
  // Get the deepest node at the position. LSP characters and tree-sitter
  // columns are both UTF-16 code units, so no conversion is needed.
  let node: Node | null = tree.rootNode.descendantForPosition({
    row: line,
    column: character,
  });
```

`lintRules/missingReturn.ts:55-61` becomes:

```typescript
    const funcNode = tree.rootNode.descendantForPosition({
      row: decl.range.start.line,
      column: decl.range.start.character,
    });
```

which also drops its `getLineText` call and `declLineText` local.

- [ ] **Step 3: Simplify the conditional sites**

`signatureHelp.ts:160-175` no longer needs its `lines` fallback branch:

```typescript
  character: number,
): boolean {
  const openStart = openParen.startPosition;
  if (line < openStart.row || (line === openStart.row && character < openStart.column)) {
    return false;
  }
  if (closeParen) {
    const closeStart = closeParen.startPosition;
    if (line > closeStart.row || (line === closeStart.row && character >= closeStart.column)) {
      return false;
    }
  }
  return true;
```

Remove the `lines` parameter and update callers. `accessResolver.ts:404-412` similarly compares `node.startPosition.column` to `r.loc.character` directly.

- [ ] **Step 4: Delete the converters**

In `server/src/util/positionConverter.ts`, delete `utf8ToUtf16`, `utf16ToUtf8`, the module-header paragraph asserting tree-sitter emits UTF-8 bytes, and the now-unused `encoder`. Keep `getLineText` and give the module a header describing what it now is.

- [ ] **Step 5: Trim the converter test file**

In `tests/lsp/positionConverter.test.ts`, delete the `utf8ToUtf16` and `utf16ToUtf8` describe blocks and their imports, keeping only `getLineText` coverage. These tests are not wrong — they correctly test functions that no longer exist.

- [ ] **Step 6: Typecheck — a clean build is the completeness proof**

Run: `bun run typecheck`
Expected: PASS. Any remaining reference to a deleted export is a compile error, which is exactly why the functions are deleted rather than neutralised.

- [ ] **Step 7: Commit**

```bash
git add server/src tests/lsp/positionConverter.test.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "fix: stop converting tree-sitter positions to UTF-16"
```

---

### Task 4: Delete the offset map

The same false premise, optimised. Separate task because a reviewer could accept Task 3 and reject this one on performance grounds.

**Files:**
- Delete: `server/src/util/offsetMap.ts`
- Modify: `server/src/features/scope-helpers.ts`, `scope-helpers-lookup.ts`, `referenceCollector.ts`, `symbolTable.ts`

**Interfaces:**
- Consumes: Task 3's converter-free call sites.
- Produces: `toLocUtf16(point, lines?)` and `containsPosition(range, start, end)` in `scope-helpers.ts` with their `offsetMap` parameters gone. Later readers of this plan: these functions keep their names, only their signatures shrink.

- [ ] **Step 1: Collapse the offset-map branches**

In `scope-helpers.ts`, the three-way branch reduces to a pass-through:

```typescript
export function toLocUtf16(point: Point): Position {
  return { line: point.row, character: point.column };
}

export function toRangeUtf16(node: Node): Range {
  return { start: toLocUtf16(node.startPosition), end: toLocUtf16(node.endPosition) };
}

export function containsPosition(range: Range, start: Point, end: Point): boolean {
  // ...existing body, using start.column and end.column directly
}
```

Both functions keep the `Utf16` suffix in their names — the values genuinely are UTF-16 code units; what was wrong was believing they needed converting.

- [ ] **Step 2: Drop the parameter from the four consumers**

Remove `offsetMap` arguments and the `OffsetMap` type import from `scope-helpers-lookup.ts`, `referenceCollector.ts`, and `symbolTable.ts`, including wherever `buildOffsetMap` is called at parse time.

- [ ] **Step 3: Delete the module**

```bash
git rm server/src/util/offsetMap.ts
```

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the tests from Task 2 — they must now pass**

Run: `bun test tests/lsp/nonAsciiPositions.test.ts`
Expected: PASS, all four.

- [ ] **Step 6: Commit**

```bash
git add -A server/src
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "perf: remove byte-to-UTF-16 offset map"
```

---

### Task 5: Encoding detection

**Files:**
- Create: `server/src/util/sourceDecoder.ts`
- Create: `tests/lsp/sourceDecoder.test.ts`
- Modify: `server/src/features/backgroundIndex.ts:222`, `server/src/serverDocumentHandler.ts:266`, `server/src/serverLifecycle.ts:111`, `server/src/features/hoverContent.ts:251`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `decodeSource(buf: Buffer): { text: string; encoding: string }` and `readSource(path: string): Promise<string>`, used by the four call sites and by the Roxen corpus runner in the follow-on change.

- [ ] **Step 1: Write the failing decoder tests**

Create `tests/lsp/sourceDecoder.test.ts`:

```typescript
/**
 * Source encoding detection.
 *
 * Pike source predating universal UTF-8 is commonly ISO-8859-1 — 241 of the
 * 442 Pike files in Roxen 6.1 are. Reading those as UTF-8 substitutes U+FFFD
 * for each non-ASCII byte, corrupting the text and every offset derived
 * from it.
 */

import { test, expect, describe } from "bun:test";
import { decodeSource } from "../../server/src/util/sourceDecoder";

describe("decodeSource", () => {
  test("decodes valid UTF-8 as UTF-8", () => {
    const buf = Buffer.from("// Copyright © 2009\nint x;\n", "utf-8");
    const { text, encoding } = decodeSource(buf);
    expect(encoding).toBe("utf-8");
    expect(text).toContain("©");
    expect(text).not.toContain("�");
  });

  test("decodes ISO-8859-1 bytes as ISO-8859-1", () => {
    // 0xA9 is © in ISO-8859-1 and an invalid lone continuation byte in UTF-8.
    const buf = Buffer.from([
      ...Buffer.from("// Copyright "), 0xa9, ...Buffer.from(" 2009\nint x;\n"),
    ]);
    const { text, encoding } = decodeSource(buf);
    expect(encoding).toBe("iso-8859-1");
    expect(text).toContain("©");
    expect(text).not.toContain("�");
  });

  test("honours an explicit #charset directive over valid UTF-8", () => {
    const buf = Buffer.from("#charset iso-8859-2\nint x;\n", "utf-8");
    const { encoding } = decodeSource(buf);
    expect(encoding).toBe("iso-8859-2");
  });

  test("honours #charset utf-8", () => {
    const buf = Buffer.from("#charset utf-8\nint x;\n", "utf-8");
    expect(decodeSource(buf).encoding).toBe("utf-8");
  });

  test("pure ASCII decodes as UTF-8 unchanged", () => {
    const buf = Buffer.from("int main() { return 0; }\n", "utf-8");
    const { text, encoding } = decodeSource(buf);
    expect(encoding).toBe("utf-8");
    expect(text).toBe("int main() { return 0; }\n");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/lsp/sourceDecoder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the decoder**

Create `server/src/util/sourceDecoder.ts`:

```typescript
/**
 * Pike source decoding.
 *
 * Detection order: an explicit `#charset` directive, else UTF-8 when the bytes
 * are valid UTF-8, else ISO-8859-1. The fallback cannot fail — every byte
 * sequence is valid ISO-8859-1 — so detection always yields text.
 *
 * Applies to Pike source only. Server-owned JSON stays UTF-8.
 */
import { readFile } from "node:fs/promises";

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Matches `#charset <name>` in the leading region of a file. */
const CHARSET_RE = /^[ \t]*#charset[ \t]+([A-Za-z0-9_-]+)/m;

export interface DecodedSource {
  text: string;
  encoding: string;
}

export function decodeSource(buf: Uint8Array): DecodedSource {
  const declared = findCharset(buf);
  if (declared) {
    try {
      return { text: new TextDecoder(declared).decode(buf), encoding: declared };
    } catch {
      // Unknown or unsupported label — fall through to sniffing.
    }
  }

  try {
    return { text: strictUtf8.decode(buf), encoding: "utf-8" };
  } catch {
    return {
      text: new TextDecoder("iso-8859-1").decode(buf),
      encoding: "iso-8859-1",
    };
  }
}

/**
 * Read the `#charset` label, if any. Scans only the first 4KB as ASCII: the
 * directive must precede code, and this avoids decoding the file twice.
 */
function findCharset(buf: Uint8Array): string | null {
  const head = new TextDecoder("iso-8859-1").decode(buf.subarray(0, 4096));
  const m = CHARSET_RE.exec(head);
  return m ? m[1]!.toLowerCase() : null;
}

/** Read a Pike source file from disk, decoding by detected encoding. */
export async function readSource(path: string): Promise<string> {
  return decodeSource(await readFile(path)).text;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/lsp/sourceDecoder.test.ts`
Expected: PASS, all five.

- [ ] **Step 5: Route the four source reads through it**

At each site, replace `readFile(path, "utf-8")` with `readSource(path)`:

- `server/src/features/backgroundIndex.ts:222` — inside the `measureAsync("readFile", ...)` wrapper; keep the wrapper.
- `server/src/serverDocumentHandler.ts:266`
- `server/src/serverLifecycle.ts:111`
- `server/src/features/hoverContent.ts:251` — this one is synchronous `readFileSync`; use `decodeSource(readFileSync(path))` rather than making it async.

- [ ] **Step 6: Audit for stragglers**

Run: `grep -rn 'readFile.*utf-8\|readFileSync.*utf8' server/src --include=*.ts`

For each remaining hit, confirm it reads server-owned JSON (caches, manifests) and leave it. Pike source must go through `readSource`/`decodeSource`.

- [ ] **Step 7: Typecheck and commit**

```bash
bun run typecheck
git add server/src/util/sourceDecoder.ts tests/lsp/sourceDecoder.test.ts server/src
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "fix: decode Pike source by detected encoding"
```

---

### Task 6: Cache invalidation

Positions cached under the old decoder are wrong and would survive the fix.

**Files:**
- Modify: `server/src/features/persistentCache.ts:90`
- Modify: `server/src/features/cacheManifest.ts:23`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces: nothing consumed downstream.

- [ ] **Step 1: Bump both format versions**

In `server/src/features/persistentCache.ts:90`:

```typescript
const FORMAT_VERSION = 3; // Positions are UTF-16 pass-through (was 2: byte-converted)
```

In `server/src/features/cacheManifest.ts:23`:

```typescript
const FORMAT_VERSION = 3;
```

- [ ] **Step 2: Verify stale caches are discarded**

Run: `bun test tests/lsp/cacheLazy.test.ts`
Expected: PASS. Both modules already gate on `formatVersion !== FORMAT_VERSION` (`persistentCache.ts:380`, `cacheManifest.ts:102`), so the bump is sufficient; confirm no test hardcodes the old value.

- [ ] **Step 3: Commit**

```bash
git add server/src/features/persistentCache.ts server/src/features/cacheManifest.ts
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -m "fix: invalidate caches built with converted positions"
```

---

### Task 7: Full verification

**Files:** none modified — this task gates the change.

- [ ] **Step 1: Full serial suite against the baseline**

Run: `bun test 2>&1 | tail -20`
Expected: green — at least `2280 pass / 0 fail`, plus the tests this change adds. The baseline was measured in Task 1 as `2280 pass / 2 skip / 0 fail`. Any failure is a regression from this change and must be fixed before proceeding, not accepted.

Also run: `bun run typecheck` — must exit clean.

- [ ] **Step 2: Perf and memory check**

Run: `bun test tests/perf`
Expected: no regression on position-heavy paths. Removing the offset map eliminates a per-file `Int32Array` built at parse time; record the memory effect, since it should be an improvement and a regression would mean something was replaced rather than removed.

- [ ] **Step 3: Quality gates**

Run: `bash scripts/quality-gates.sh`
Expected: PASS — files ≤500 lines, functions ≤50 lines.

- [ ] **Step 4: Verify against real ISO-8859-1 Pike source**

Use a Roxen 6.1 source file (over half the corpus is ISO-8859-1; `server/modules/throttling/throttling_byuser.pike` is a confirmed example). Open it in the editor with the built extension and confirm:
- the copyright `©` renders as `©`, not `` — proving Task 5
- hovering a symbol describes that symbol
- Ctrl+Click navigates to that symbol's definition
- no diagnostic underlines an unrelated span

- [ ] **Step 5: Confirm the corpus parse is unchanged**

Re-run the corpus parse from the diagnosis against Roxen 6.1 with the new decoder. Expected: the 14 genuinely-failing files are still exactly 14 — the encoding fix must not change grammar outcomes, only text correctness. A different number means the decoder altered parse behaviour and needs investigation.

- [ ] **Step 6: Final commit if anything was amended**

```bash
PRE_COMMIT_ALLOW_NO_CONFIG=1 git commit -am "fix: address verification findings"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Positions map without conversion | 3, 4 |
| Range on non-ASCII line | 2, 3 |
| Position lookup on non-ASCII line | 2, 3 |
| Astral-plane characters | 1 (binding), 2 (feature) |
| ASCII lines unaffected | 7 (full suite) |
| Binding unit semantics asserted | 1 |
| Feature ranges verified end to end | 2, 7 |
| Source decoded by detected encoding | 5 |
| `#charset` honoured | 5 |
| Valid UTF-8 path | 5 |
| ISO-8859-1 fallback | 5 |
| Decoded text drives positions | 7 |
| Detection applies to every source read | 5 |
| Indexed and opened text agree | 5, 7 |
| Non-source files unaffected | 5 |

No gaps.

**Known plan-level uncertainties, stated rather than hidden:**

- Task 2's expected pre-fix values were measured against the current build with a throwaway probe, not predicted. That probe corrected two errors in an earlier draft of this plan: the original fixture placed the non-ASCII character on a different line from the token, which produces no drift at all and would have passed before the fix; and it asserted on `textDocument/documentLink`, which returns `[]` in the in-process test server and would have failed for the wrong reason.
- Task 3's `lines` parameter removals cascade into call signatures the plan does not enumerate exhaustively. The typecheck in Step 6 is the mechanism that finds them; this is deliberate, not an omission.
