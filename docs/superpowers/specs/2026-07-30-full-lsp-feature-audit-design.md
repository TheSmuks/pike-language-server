# Full LSP Feature Audit — Design

Date: 2026-07-30
Status: Approved, not yet implemented

## Problem

Audit iterations 1–6 were code-reading reviews: read a module, compare it to
the LSP spec and its declared capability, record what looks wrong. That method
finds dead code, unwired settings, and spec violations. It does not find
defects that appear only on real input at real scale, because it never runs
anything.

The premise of this audit is that something *is* broken. That inverts the
method: the job is to make defects reveal themselves, not to reason about
whether they could exist. Evidence first, reading second.

A live example of the gap, found while scoping this design:
`serverCapabilities.ts:125` declares `documentRangeFormattingProvider: true`,
while iteration-6 finding F1 recorded range formatting as not implemented.
Either it landed since, or the server advertises a capability it does not
honour. A behavioural sweep answers that in one request; reading two documents
does not.

## Scope

Four surfaces, all of them:

1. **Server LSP features** — all 26 capabilities declared by
   `buildServerCapabilities()`.
2. **Roxen layer** — `roxenDetection`, `roxenIndex`, `roxenResolution`,
   `roxenActivation` against a real install layout.
3. **Extension/client layer** — TextMate grammar, language configuration,
   activation, settings plumbing.
4. **Standalone / non-VSCode** — the `--stdio` path used by Neovim and Helix.

Out of scope: fixes (this audit reports only), CI wiring, and the internals of
sibling repos (`tree-sitter-pike`, `pike-fmt`).

## Architecture

Four stages, run in order.

### Stage A — Behavioural sweep

A new harness boots the real server through `createTestServer` — the same path
`scripts/lsp-probe.ts` uses, so it exercises production code rather than a
parallel implementation — and fires every declared capability at every
meaningful position, recording each result to a ledger.

Two workspaces, answering different questions:

| Workspace | Files | Question it answers |
|---|---|---|
| `corpus/` | 80 | Are the answers *correct*? Expected values are known. |
| `/tank/projects/roxen-6.1` | 448 | Does it *survive* real code at scale? Answers unknown. |

The Roxen tier additionally records RSS per phase, making it a memory-governor
check under realistic load.

**Position selection.** Firing every capability at every offset is
combinatorial and mostly meaningless. Positions are driven from the symbol
table instead: **every** declaration site, plus **up to 5 reference sites per
declaration**, taken in source order. Those are the positions where a feature
is obligated to answer, which is what makes an empty result a defect rather
than a shrug. The reference cap keeps a heavily-used symbol from dominating
the run without hiding a class of position — the first five occurrences of a
symbol already span declaration-adjacent and distant uses.

**Capability matrix**, grouped by driver:

| Driver | Capabilities |
|---|---|
| Position (per declaration + sampled refs) | hover, definition, declaration, typeDefinition, implementation, references, prepareRename + rename, documentHighlight, signatureHelp, selectionRange, callHierarchy (prepare/incoming/outgoing), typeHierarchy (prepare/super/sub), completion + resolve |
| Document (once per file) | documentSymbol, semanticTokens full + range + delta, foldingRange, inlayHint, documentLink, codeLens + resolve, formatting, rangeFormatting, onTypeFormatting, codeAction |
| Workspace | workspaceSymbol, didRenameFiles |
| Lifecycle | incremental sync churn, save-with-text, push diagnostics |

`semanticTokens delta` is edited-and-re-requested rather than asked once: delta
bugs are invisible until a specific edit sequence produces a wrong patch.

Push diagnostics are swept as-is. The server is push-only by design; a
`diagnosticProvider` capability is deliberately absent and its absence is not
a finding.

### Stage B — Oracle gate

Pike is the oracle. Any Roxen file where the sweep reports something suspicious
is classified by `tools/roxen-lab`'s `oracle.pike`:

| Verdict | Meaning for the finding |
|---|---|
| `ok`, `semantic` | Source is valid Pike. The defect is ours. |
| `cpp_error` | Macro-expansion gap; raw source is not what the compiler sees. Ours, but a different defect. |
| `syntax` | Pike rejects it too. Not our defect — discard. |

Without this gate a Roxen-driven audit produces a findings list padded with
non-defects, because Roxen contains source that no correct tool would accept.

### Stage C — Code read

The sweep cannot reach everything. After it lands, read:

- every module the sweep flagged, to find the cause behind the symptom;
- the surfaces the sweep structurally cannot exercise — TextMate grammar,
  language configuration, client activation, settings plumbing.

### Stage D — Report

`docs/audits/iteration-7.md`, in the format established by iterations 1–6:
finding-summary table, then per-area architecture, findings table, and "what
works well". Plus a row in `docs/audits/README.md`.

## Severity assignment

Severity comes from the assertion tier, not from judgement:

| Tier | Signal | Severity floor |
|---|---|---|
| 0 | Crash, exception, timeout, malformed LSP response | Critical |
| 1 | Capability declared but returns null/empty where it must not | High |
| 2 | Returns a result, but the wrong one (corpus tier only) | Medium |
| 3 | Degraded — slow, over budget, noisy | Low |

A finding may be raised above its floor with a stated reason. It is never
lowered.

## The credibility rule

A sweep harness that emits false defects is worse than no harness: it produces
a findings list nobody trusts and burns review time on non-bugs. Two defences,
both mandatory.

1. **Every finding ships with a hand-runnable reproduction** — a literal
   command such as `bun run scripts/lsp-probe.ts hover path/to/file.pike 42:17`
   that shows the bad result *outside* the harness. If it cannot be reproduced
   by hand, it is not a finding; it is a harness artifact, and the harness gets
   fixed.
2. **Negative controls.** The harness is calibrated on the corpus tier first,
   where answers are known. If it reports defects on files known to be handled
   correctly, the harness is wrong and is fixed before the Roxen tier runs at
   all.

## Components

`tools/lsp-audit/`, split to stay inside the TigerStyle gates (files ≤500
lines, functions ≤50 lines):

| File | Purpose | Depends on |
|---|---|---|
| `matrix.ts` | Declarative capability list: driver kind, request builder, result validator per capability. No I/O. | LSP types |
| `ledger.ts` | Append-only JSONL writer with continuous flush; reader for triage. | node:fs |
| `sweep.ts` | Boots the server, walks workspace × matrix, writes ledger records. | matrix, ledger, tests/lsp/helpers |
| `oracle.ts` | Runs `oracle.pike` in the lab container for one file; returns the verdict. | docker |
| `triage.ts` | Reads a ledger, applies the severity tiers and the oracle gate, emits findings. | ledger, oracle |

Each unit is independently testable: `matrix.ts` is pure data, `ledger.ts` is
pure I/O, `triage.ts` is a pure function from ledger records to findings.
Only `sweep.ts` needs a live server, and only `oracle.ts` needs Docker.

## Data flow

```
corpus/  ─┐
          ├─> sweep.ts ──> ledger.jsonl ──> triage.ts ──> iteration-7.md
roxen-6.1 ┘                                    │
                                          oracle.ts (Docker)
```

Triage is a separate pass over a persisted ledger, so re-triaging with adjusted
thresholds never requires re-sweeping.

## Error handling

- **Server crash mid-sweep.** The ledger is flushed per record, so a crash
  costs one record. The sweep resumes from the last ledger entry.
- **Per-request timeout.** Each request is bounded at **10 seconds**; a
  timeout is recorded as a Tier-0 result rather than hanging the run. No
  interactive LSP request has a defensible reason to exceed that, so the bound
  doubles as a Tier-3 latency signal: any request over **1 second** is
  recorded as degraded even when it eventually answers.
- **Docker unavailable.** `oracle.ts` reports unavailable; triage marks
  affected Roxen findings `unclassified` rather than guessing. Corpus-tier
  findings are unaffected.
- **Roxen tree absent.** The Roxen tier is skipped with a recorded reason; the
  corpus tier still runs.

## Testing

The harness is a tool, not shipped code, but it gates the audit's credibility,
so it gets tests:

- `matrix.ts` — every declared server capability has a matrix entry. This test
  fails when a capability is added to `serverCapabilities.ts` without a sweep
  entry, which is the exact mechanism that lets an unimplemented capability
  ship advertised.
- `ledger.ts` — round-trip write/read, and truncation recovery.
- `triage.ts` — fixture ledgers in, expected findings out, one per severity
  tier.

## Runtime

The Roxen tier plus per-file oracle classification is not a fast loop: expect
tens of minutes for a full sweep, plus seconds per suspicious file in Docker.
This is acceptable for a manual audit and is the reason the ledger checkpoints.

## Deliberate exclusions

- **No CI wiring.** The lab is explicitly not a CI dependency; a
  Docker-gated, tens-of-minutes sweep should not become one.
- **No snapshots for the Roxen tier.** Correct answers are unknown there, so a
  golden file would freeze current behaviour *including its bugs* and label it
  a baseline. Only the corpus tier gets expected values.
- **No fixes.** Findings only; prioritisation and repair are a follow-up.
- **No grammar or formatter internals.** Gaps found are recorded as findings
  pointing upstream, not chased into sibling repos.

## Success criteria

1. All 26 declared capabilities exercised on both workspaces, with a ledger
   record per attempt.
2. All four surfaces covered.
3. Every finding carries a hand-runnable reproduction that does not involve
   the harness.
4. Every Roxen-tier finding carries an oracle verdict, or is explicitly marked
   `unclassified`.
5. `docs/audits/iteration-7.md` written in the established format, and
   `docs/audits/README.md` updated.
