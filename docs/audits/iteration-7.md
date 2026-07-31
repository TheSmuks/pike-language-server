# Audit Iteration 7 — Full LSP Feature Audit

Date: 2026-07-30

Scope: Behavioural sweep of all 26 declared capabilities across four surfaces
(server, Roxen layer, extension client, standalone stdio), oracle-gated against
Pike, followed by a code read of the flagged modules.

Unlike iterations 1–6, which read code and reasoned about what could be wrong,
this iteration ran the server and recorded what it actually did: **208,816 LSP
requests** across 529 Pike files.

## Finding Summary

| Severity | Count (distinct defects) |
|----------|--------------------------|
| Critical | 0 |
| High     | 7 |
| Medium   | 2 |
| Low      | 5 |
| **Total** | **14** |

Those 14 distinct defects account for 6,886 individual finding instances. The
report groups by root cause; the raw instance counts are given per finding.

## Headline Result

**Zero crashes and zero timeouts.** Across 200,927 requests against all 442
Pike files in Roxen 6.1, and 7,889 against the semantic corpus, the server did
not fall over once, did not hang once, and never returned a malformed response.
Every Critical-tier signal the harness can emit stayed at zero.

What it does do is return nothing where it owes an answer — 7,350 times.

## Method

| Stage | What it did |
|---|---|
| Sweep | Booted the real server via `createTestServer` (the same path `lsp-probe` uses) and fired every declared capability at every declaration site plus up to 5 reference sites per declaration. |
| Oracle gate | Compiled every suspicious Roxen file with real Pike in `tools/roxen-lab`. `ok`/`semantic`/`cpp_error` ⇒ the source is valid, the defect is ours. `syntax` ⇒ Pike rejects it too; discarded. |
| Triage | Mapped assertion tier to severity mechanically: crash/timeout ⇒ Critical, empty-where-required ⇒ High, wrong answer ⇒ Medium, slow ⇒ Low. |
| Code read | Traced each flagged capability to its handler. |

Two workspaces, answering different questions: `corpus/` (87 files) has known
correct answers and catches **wrong** results; `/tank/projects/roxen-6.1` (442
files) has unknown answers and catches **crashes, empties and slowness** at
real-world scale.

Harness: `tools/lsp-audit/`. Re-runnable via `bun run audit:sweep` /
`audit:triage` / `audit:standalone`, and
`node tools/lsp-audit/client-surface-check.mjs`.

---

## Area 1: Server LSP — Navigation and Symbol Resolution

### Architecture

`navigationGoTo.ts` registers `onDefinition` and `onDeclaration`; both delegate
to the same `handleDefinition`. `navigationDocumentFeatures.ts` owns
`documentHighlight`. All three read a symbol table produced by
`symbolTable.ts`/`scopeBuilder.ts`.

### Findings

| # | Sev | Finding | Instances | Location | Reproduction |
|---|-----|---------|-----------|----------|--------------|
| N1 | H | `documentHighlight` returns `null` for a symbol that occurs only once. The guard `if (refs.length === 0) return null` is redundant with `buildDocumentHighlights`, which already ends `return highlights.length > 0 ? highlights : null` — *except* when `targetDecl` is non-null and `refs` is empty, which is exactly the single-occurrence case, and exactly where it gives the wrong answer. LSP defines the request as all highlights at a position, and a declaration is an occurrence; rust-analyzer, gopls and tsserver all highlight a lone declaration. | 4,242 (4,031 Roxen + 211 corpus) | `navigationDocumentFeatures.ts:381` | `bun run scripts/lsp-probe.ts raw textDocument/documentHighlight corpus/files/basic-collections.pike '{"position":{"line":6,"character":4}}'` |
| N2 | H | `definition` and `declaration` return no result at 719 positions the oracle confirms are valid Pike. The two return **identical** counts at every oracle verdict (73/73, 319/319, 16/16), which the code read confirms: `navigationGoTo.ts:51` wires `onDeclaration` to the same `handleDefinition`. One defect, surfaced twice — the instance count below therefore counts both methods. | 830 (816 Roxen + 14 corpus) | `navigationGoTo.ts:45-51` | `bun run scripts/lsp-probe.ts define server/base_server/basic_defvar.pike 40:21` |
| N3 | H | `references` returns nothing at 606 valid positions. | 606 (596 Roxen + 10 corpus) | `referenceCollector.ts` | `bun run scripts/lsp-probe.ts raw textDocument/references server/base_server/basic_defvar.pike '{"context":{"includeDeclaration":true},"position":{"line":39,"character":20}}'` |
| N4 | M | `references` on an inherited member returns only the declaration, missing the uses the expectation set requires. Caught by tier 2 — the corpus knows the right answer. | 1 | `class-multi-inherit.pike:11` | `bun run scripts/lsp-probe.ts raw textDocument/references corpus/files/class-multi-inherit.pike '{"context":{"includeDeclaration":true},"position":{"line":10,"character":9}}'` |

### What Works Well

- 191,187 of 200,927 Roxen requests returned a real answer.
- The symbol table resolves positions that `documentHighlight` rejects:
  `definition` and `prepareRename` both answer at the same coordinates, which
  is what proves N1 is a guard bug and not a resolution failure.

---

## Area 2: Server LSP — Completion, Hover, Rename

### Findings

| # | Sev | Finding | Instances | Location | Reproduction |
|---|-----|---------|-----------|----------|--------------|
| C1 | H | `completion` returns an empty list at 801 valid positions. | 801 (791 Roxen + 10 corpus) | `completion.ts` | `bun run scripts/lsp-probe.ts complete server/base_server/basic_defvar.pike 40:21` |
| C2 | H | `hover` returns nothing at 387 valid positions. | 387 (381 Roxen + 6 corpus) | `hoverHandler.ts` | `bun run scripts/lsp-probe.ts hover server/base_server/basic_defvar.pike 40:21` |
| C3 | M | **`prepareRename` on the keyword `this` offers to rename the enclosing class.** At `return this;` it returns `placeholder: "Builder"` with a range at the *class declaration* four lines earlier. This violates the LSP requirement that the returned range contain the requested position, and accepting the rename would be destructive: the user asked about `this` and would rewrite the class. Caught by tier 2. | 1 | `navigationRefactoring.ts` | `bun run scripts/lsp-probe.ts raw textDocument/prepareRename corpus/files/class-this-object.pike '{"position":{"line":8,"character":11}}'` |
| C4 | L | `hover` exceeded 1s at 11 positions across 7 files (peak 1,371 ms). | 11 | `hoverHandler.ts` | `bun run scripts/lsp-probe.ts hover server/base_server/roxen.pike 9:10` |
| C5 | L | `completion` exceeded 1s at 2 positions (peak 1,141 ms). | 2 | `completion.ts` | `bun run scripts/lsp-probe.ts complete server/base_server/rxml.pike 210:13` |

### What Works Well

- The rename **guard** works correctly and was measured doing so: 2,641 Roxen
  requests were declined deliberately with a JSON-RPC `InvalidRequest`, never a
  crash. Distinguishing a decline from a failure was the single most important
  calibration fix in this audit (see Methodology).

---

## Area 3: Server LSP — Document Features

### Findings

| # | Sev | Finding | Instances | Location | Reproduction |
|---|-----|---------|-----------|----------|--------------|
| D1 | H | `foldingRange` returns nothing for two Roxen files the oracle confirms are valid. | 2 | `foldingRange.ts` | `bun run scripts/lsp-probe.ts raw textDocument/foldingRange server/site_templates/proxy.pike '{}'` |
| D2 | H | `semanticTokens/range` returns an empty token array for `__default.pmod`. | 1 | `semanticTokens.ts` | `bun run scripts/lsp-probe.ts raw textDocument/semanticTokens/range server/base_server/__default.pmod '{"range":{"start":{"line":0,"character":0},"end":{"line":100000,"character":0}}}'` |
| D3 | L | `implementation` took 9,229 ms on a 4-line file — the slowest single request in the audit, 9× the latency budget. | 1 | `implementation.ts` | `bun run scripts/lsp-probe.ts raw textDocument/implementation server/arg_cache_plugins/replicate.pike '{"position":{"line":3,"character":9}}'` |
| D4 | L | `inlayHint` took 1,001 ms on `rxmltags.pike`. | 1 | `inlayHints.ts` | `bun run scripts/lsp-probe.ts raw textDocument/inlayHint server/modules/tags/rxmltags.pike '{"range":{"start":{"line":0,"character":0},"end":{"line":100000,"character":0}}}'` |

### What Works Well

- Document-driven capabilities are the most reliable surface in the server:
  `documentSymbol`, `semanticTokens/full`, `codeLens` and `documentLink`
  produced zero empty results across 442 Roxen files.

---

## Area 4: Standalone / Non-VSCode (Neovim, Helix)

### Architecture

`main.ts` is the only entry that listens; `--stdio` or `PIKE_LSP_STDIO=1`.
Configuration arrives **only** through `initializationOptions` — there is no
`workspace/configuration` round trip.

### Findings

**None.** This surface is clean.

A deliberately minimal client — no `hierarchicalDocumentSymbolSupport`, no
`resolveSupport`, no snippet support, configured solely through
`initializationOptions` — spawned the shipped `standalone/server.js` over a real
pipe and exercised all 26 capabilities. **0 errored, 0 unexpectedly empty.**

This is a genuine negative result, not an absence of testing: every capability
returned a real answer or a legitimately empty one. No VSCode-only assumption
exists on this path.

Reproduction: `bun run build:standalone && bun run audit:standalone`

---

## Area 5: Extension / Client

### Findings

| # | Sev | Finding | Location | Reproduction |
|---|-----|---------|----------|--------------|
| E1 | L | The server emits a `namespace` semantic token over the quoted module path in `inherit "file.pike"`, which the TextMate layer colours as a string. The two highlight layers disagree on 3 of 590 tokens. Defensible — the inherit target genuinely is a module reference — but undocumented, and only visible when semantic highlighting is enabled (off by default since 0.8.43). | `semanticTokens.ts` | `node tools/lsp-audit/client-surface-check.mjs tokens` |

### What Works Well

- **All 28 contributed settings are read by shipped code.** No repeat of
  iteration 6's `builtinFunction` defect class (declared in the manifest, never
  emitted). Verified by `client-surface-check.mjs settings`.
- 587 of 590 semantic tokens fall outside comments and string literals.

### Not Run

**Activation against a real Roxen module was not tested.** It requires the
VSCode extension host, which this audit did not launch. It is not covered by
any finding above, and no conclusion about it should be drawn from this report.

---

## Area 6: Roxen Layer

The Roxen layer was exercised implicitly: 442 real Roxen files were opened,
indexed and queried, and the module layout resolved well enough that 95.1% of
requests returned answers. No Roxen-specific detection or resolution defect
surfaced.

The oracle gate itself was validated: of 440 suspicious files, 436 produced
findings and 4 were discarded as `syntax`. Those four were re-run
**individually** — one file per container, so no crashing neighbour could
suppress them — and all four independently confirmed `syntax`. Nothing was lost.

---

## Methodology Notes

Three notes that bear on how much weight these findings carry.

**The harness was calibrated before it was trusted.** The first calibration pass
sampled ten corpus findings; all ten reproduced by hand, and all ten were still
*harness* bugs — nine came from a hidden `.integration-fixtures` directory of
deliberately-invalid Pike created at runtime by `tests/integration/suite/index.ts`,
and one landed inside a `//!` comment. Four harness defects were fixed before
the Roxen run.

**Deliberate declines were nearly reported as crashes.** The rename guard
returns a JSON-RPC `InvalidRequest` when a symbol may not be renamed. The
harness initially scored every rejection as a crash — which would have produced
2,641 false Criticals on Roxen and buried this report. The fix keys on error
code, and is safe by construction: `vscode-jsonrpc` converts every unexpected
handler throw to `InternalError (-32603)` before the client sees it, and neither
library ever emits `InvalidRequest (-32600)` — the only three sites that do are
our own guard returns.

**One finding in this report was nearly a false positive from the author.** An
initial settings check flagged `pike.languageServer.log.redactPaths` as declared
but never read. It was wrong: the reader is `client/extension.ts:233`, and the
search had covered `client/src`. Verified before publication, and the corrected
check finds all 28 settings wired.

---

## Limitations

Stated plainly, because a reader would otherwise over-read these results.

1. **The Roxen tier cannot catch wrong answers.** There is no ground truth for
   Roxen's correct results, so those 442 files were checked only for crashes,
   empties and latency. Both of the wrong-answer defects in this report (N4, C3)
   came from the 87-file corpus. A wrong answer on Roxen would not have been
   detected.

2. **Roughly 15 of the 26 capabilities are only weakly checked.** Capabilities
   where an empty result is legitimate (`typeDefinition`, `implementation`,
   `codeAction`, `inlayHint`, the formatting family, both hierarchies) are
   validated only as "answered without erroring". A handler that consistently
   returned `null` would be indistinguishable from one correctly returning
   `null`. Those capabilities are **not** demonstrated to work by this audit.

3. **Tier-2 coverage is 20 expectations across 10 files.** It caught two real
   defects, but it is a spotlight, not a net.

4. **`semanticTokens/full/delta` findings are not reproducible by their own
   command.** A delta bug needs a live edit sequence that triage cannot
   reconstruct from a ledger record; the generated command reaches the handler
   but falls back to returning full tokens.

5. **Peak RSS of 1,281 MB is not a memory regression measurement.** The sweep
   runs via `bun run tools/lsp-audit/cli.ts`, not `bin/pike-language-server`, so
   the 512 MB default budget and `--max-old-space-size` were not in effect, and
   the figure includes the harness process. It says indexing 442 Roxen files
   in-process with the governor inactive reaches 1.28 GB — a statement about
   workload size, nothing more.

6. **Client activation was not tested** (see Area 5).

---

## Fixes Applied

N1, C3, and part of the N2/N3/C1/C2 cluster were fixed after this report was
first written. Each is covered by new regression tests; the remaining findings
are untouched.

### N1 — `documentHighlight` on a lone declaration (`1fbd95c`)

Removed the `if (refs.length === 0) return null` guard.
`buildDocumentHighlights` already returns `null` when it finds nothing, so the
guard only ever suppressed the case it got wrong. The pre-existing "returns
null for position with no symbol" test still passes, which is what shows the
legitimate-null path survived.

### C3 — `prepareRename` returning the wrong range (`7d3017c`)

Investigation found the defect was **broader than this report first recorded**.
`prepareRename` returned the *declaration's* range in every case, not just for
`this`. On an ordinary reference it also pointed at the declaration:

```
prepareRename at reference (line 2, char 16) → range {line 1, char 6-11}   ← declaration
```

LSP requires the returned range to contain the requested position, because
clients use it to pre-select the text being renamed. So rename-from-a-reference
highlighted the wrong span for every symbol, everywhere — `this` → `Builder`
was the most harmful instance of a general bug, not a special case.

The keyword guard could not catch the `this` case by construction: it tests the
*resolved declaration's* name (`"Builder"`), never the token the user pointed
at. The fix keeps the declaration for renameability and the placeholder, but
returns the range of the occurrence under the cursor, and rejects a position
that is not an occurrence of that symbol at all.

### N2/N3/C1/C2 (partial) — the inherit qualifier in `A::member()` (`e10a6e3`)

The post-N1 corpus run showed `definition`, `declaration`, `references`,
`hover`, `completion` and `documentHighlight` all failing at one position:
`class-multi-inherit.pike:18`, on the **`A` in `A::value()`**. Probing isolated
it exactly — the member *after* `::` resolved, the qualifier *before* it did
not:

| Position | Before |
|---|---|
| `A` in `inherit A` | resolves |
| `value` in `A::value()` | resolves |
| `A` in `A::value()` | **null** |

`collectScopeRef` recorded a reference only for the member, reading the
qualifier solely to resolve it and never recording it. Nothing existed at that
position, so every position-driven feature returned null. The fix records the
qualifier as a reference resolved the same way a type reference is — it names a
class, exactly like one. Six capabilities, one cause.

### N2/N3/C1/C2 (part 2) — members reached through a subscript (`bd36bea`)

`variables[var]->set(...)` — the pattern behind the bulk of the Roxen empties —
resolved the receiver to the *container* declaration, so the member was looked
up on a class literally named `mapping(string:Variable.Variable)`. The member
belongs to the **element** type. Two code paths needed it: `postfixRefs.ts`
(reference recording, which also could not find the receiver at all, because
`extractLhsIdentifier` descends to the last child and a subscript ends in `]`)
and `typeResolver.ts`/`accessResolver.ts` (the query-time path definition and
hover actually use).

Verified: `mapping(string:Item)` and `array(Item)` now resolve; the direct
`single->configure` case is unchanged.

### Where the Roxen empties actually are

The Roxen sample barely moved after this fix (−25.2% → −25.8%), so the
remaining empties were characterised rather than assumed. They are **not** one
defect. A sample of live positions:

| Pattern | Example | Status after investigation |
|---|---|---|
| `global::` scope access | `global::total_size_limit` | **Fixed** (`2cbf999`). The token is `global`, not an identifier, so it fell through to the bare-`::` branch — which means "first inherited class", the opposite of what `global::` asks for. Now resolved against file scope. |
| Member on a call result | `get_sdb()->query(X,Y)` | **Not a defect.** Local call-result access already resolves (`get_db()->query()` works, and is now pinned by a test). The cited position is inside a `#define` macro body, and `get_sdb` is not declared in that file at all — so nothing could resolve it without cross-file inheritance. |
| Module-qualified element type | `mapping(string:Stdio.File)` | **Largely by design.** `definition` returns null for stdlib members whether or not a subscript is involved — deliberate, so the editor never jumps to a path that may not exist on the user's machine. `hover` works. What remains is Roxen-module classes (`Variable.Variable`), which need workspace-level Roxen detection. |

Confirmed by isolation: `mapping(string:Item)` (local class) resolves, while
`mapping(string:Stdio.File)` (module-qualified) returns null — the subscript
machinery is correct, and the block is now purely cross-module type resolution.

Investigating each individually mattered: one was a real one-line defect, one
was not a defect at all, and one is mostly intended behaviour. Characterising
the cluster from its aggregate count alone would have produced three pieces of
speculative work, two of them pointless.

**A limitation of this report's own reproduction commands, found the same way:**
`lsp-probe` opens a single file with no workspace root, so a command that
depends on workspace-level Roxen detection cannot reproduce the finding it was
generated from. Any Roxen finding that needs module resolution has to be
re-checked through the sweep, not the one-line command.

### New finding: `documentHighlight` does not resolve member accesses

Found while fixing the above, and **not** a regression: `documentHighlight`
returns null for `obj->member` in every form, including the direct
`single->configure` case that `definition` resolves fine. The arrow-access
references carry `resolvesTo: null`, and `documentHighlight` reads the
reference table rather than the access resolver that `definition` uses. Distinct
from N1, which was about lone declarations.

Reproduction:
`bun run scripts/lsp-probe.ts raw textDocument/documentHighlight <file> '{"position":{...on a ->member...}}'`

### New finding, found and fixed: member access with an outer-scope receiver (`413e853`)

`documentHighlight` returned null for `obj->member` in every form — including
the direct case `definition` resolved fine — because the two take different
paths. `definition` goes through `accessResolver`; `documentHighlight` reads the
reference table, and the member reference only resolves if its **receiver** can
be found.

That receiver lookup used `findDeclInScope`, which checks the given scope and
its *inherited* scopes but never walks the **parent** chain. A field declared on
the class is therefore invisible from inside a method body, so `single` was not
found and `single->configure(...)` resolved to nothing. Switched to
`resolveName`, which walks the chain — and which had to move into
`scope-helpers.ts` first, since `referenceCollector` imports `postfixRefs` and
exporting it the other way would have cycled.

Effect at the reported position: `null` → 3 highlights (the declaration and both
call sites).

### Methodology check: Roxen mode is active during sweeps

Confirmed directly rather than assumed, because if it were not, every
Roxen-tier empty would be an artifact of missing configuration rather than a
defect: with `rootUri` set to the Roxen tree, hover on a `MODULE_*` constant
resolves. The Roxen findings are genuine gaps.

### Measured impact

Corpus tier re-swept after all three fixes, same harness, same 87 files:

| | Before | After |
|---|---|---|
| Findings | 253 | **34** (−87%) |
| `documentHighlight` empties | 211 | **9** (−96%) |
| Tier-2 wrong answers | 2 | **1** |

**The Roxen tier improved far less, and the reason matters.** A re-sweep of 40
Roxen files that previously produced empties gives:

| | Before | After |
|---|---|---|
| Empty results | 1,567 | **1,136** (−27.5%) |

The gap is not noise. The Roxen instances of this cluster have a **different
root cause**, confirmed by inspection: the reported example
(`basic_defvar.pike:40`) sits on `set` in `variables[var]->set( value )` —
member access through a subscript expression, where the element type is not
inferred. The multi-inheritance qualifier fix does not touch that, and no
amount of re-running changes it.

So N2/N3/C1/C2 are **partially fixed**: one root cause resolved, at least one
more outstanding. The remaining Roxen empties are the type-inference gap on
indexed member access.

## Recommended Order of Work

Not a plan, just what the evidence supports.

1. ~~**N1**~~ — fixed (`1fbd95c`).
2. ~~**C3**~~ — fixed (`7d3017c`).
3. **N2/N3/C1/C2, remaining half** — type inference through indexed member
   access (`variables[var]->set(...)`). This is what the bulk of the 2,624
   Roxen instances actually are; the multi-inheritance qualifier fix above
   cleared the corpus cases but only 25% of the Roxen ones.
4. **D3** — a 9-second response on a 4-line file suggests unbounded work.
