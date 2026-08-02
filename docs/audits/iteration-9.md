# Audit Iteration 9 — Validating v0.8.55/56 Against Real Roxen 6.1

Date: 2026-08-02

Scope: the two tiers from [iteration 8](iteration-8.md), re-run against the
0.8.55/0.8.56 work, plus three measurements the previous iterations asserted
without measuring — the real dependency-cycle structure of the Roxen tree, the
real maximum dependency closure, and what the per-diagnose dependency refresh
actually costs at that maximum.

## Headline

**The corpus tier held at zero and answers more.** The Roxen tier survived
201,207 requests with no handler crash, no unhandled rejection, and flat
memory. The dependency-closure cap is confirmed safe with 3.7x headroom.

| Corpus tier | Iteration 8 | Now |
|---|---|---|
| Requests | 7,874 | 7,874 |
| Findings | 0 | **0** |
| Answered (`ok`) | 7,749 | **7,841** |
| Declined | 125 | **33** |

92 positions the server used to decline now answer, with findings still at
zero. The corpus tier is the deterministic one, so this is the tier the
no-regression claim rests on.

| Roxen tier | Iteration 8 | Now |
|---|---|---|
| Requests | ~200,936 | 201,207 |
| `error` (handler crash) | 0 | **0** |
| Empty results | 1,847 | 1,173 |
| Findings | 1,608 | 1,327 |
| Distinct defects | 25 | 48 |

The Roxen deltas are **not** claimed as improvement. That tier cannot see wrong
answers, it swings 1–2% run to run, and 30 of the 48 "distinct defects" are
Low-severity latency buckets rather than substantive findings.

## Roxen 6.1 Has No Dependency Cycles — And That Is the Interesting Part

`openDocumentRepair`'s two-phase repair exists because dependency order alone
cannot settle a cycle. It had only ever been tested on a synthetic `a<->b` pair
and a 3-cycle. Roxen was expected to supply a real one, since repo memory
records that cyclic `Variable.pmod` inherits are what stop Roxen 6.1 compiling
on Pike 8.0.

Two graphs were built, because using the LSP's own resolver to make a claim
about the LSP is circular.

**The LSP's graph is a DAG.** 442 files, 859 edges across 350 files, 442
strongly connected components, **none cyclic**. Built through the real server
with `rootUri` pointing at the tree, so Roxen detection and `pikePaths` are the
production ones. (Background indexing defers dependency resolution — without
`ensureDependenciesResolved` on every file first, the graph reads as zero
edges, which is a trap worth knowing for any future graph measurement.)

**A deliberately over-permissive textual graph finds six cycles, the largest
12.** All one pattern: a member of `X.pmod` inheriting through its own module
name — `Variable.pmod/Date.pike` has `inherit Variable.String;`,
`RXML.pmod/PEnt.pike` has `inherit RXML.PXml;`, `LazyImage.pmod/Legend.pike`
has `inherit LazyImage.LazyImage;`.

Both are right at different levels, and the difference is the point. Under
Pike's own module semantics the *directory* is the module, so resolving
`Variable.String` requires the whole directory including the file doing the
asking — which is precisely the two-pass compiler failure. The LSP resolves the
symbol to the **file that actually defines it** (`Variable.String` →
`module.pmod:1042`, where `class String` is), and that precision is what
prevents the cycle from closing.

So the absence of cycles is a property of a more precise resolver, not a
missing edge — **but the consequence stands: no real Pike code in this corpus
reaches phase two of the repair.** That path remains synthetic-only. It is a
coverage gap that this tree cannot close.

**The cluster was exercised anyway.** All 12 `Variable.pmod` members opened
from disk against a real on-disk `rootUri`:

- symbol tables: 12/12, stale entries after repair: 0
- `workspace/symbol` returns their declarations at the right lines —
  `clear_verifications` → `VerifiedString.pike:20`, `set_filename` →
  `Upload.pike:12`, `logic_mode` → `VerifiedString.pike:18`
- go-to-definition across the cluster: **9/9 correct**, each checked against the
  target file's source text for the right file *and* the right line, not merely
  a non-null answer. `Date.pike:3` and `Upload.pike:1` both land on
  `module.pmod:1042` `class String`; `Schedule`, `Mapping` and `MapLocation`
  all land on `module.pmod:191` `class Variable`; `Language.pike:3` lands on
  `module.pmod:1272` `class MultipleChoice`.

## The Dependency Closure Maximum Is 17, Not 14

Measured with `collectDependencyOverlays` itself, uncapped, over all 442 files.
The maximum is **17**, at `server/base_server/roxen.pike`. The earlier estimate
of 14 was taken without Roxen's own search paths wired in; with production
Roxen detection the same file resolves three more workspace dependencies.

| Closure size | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 10 | 17 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Files | 187 | 81 | 13 | 8 | 67 | 58 | 17 | 7 | 2 | 1 | 1 |

**64 is a safe cap.** Nothing exceeds it, the maximum is 3.7x below it, the
second-largest closure is 10, and 94% of the tree is at 5 or below. The cap was
therefore not raised. What changed is that truncation is no longer silent: a
workspace that does exceed it now says so, with the count dropped and the file.

The 187 files with an empty closure were spot-checked — `base_server/html.pike`
and `rimage/plugins/solid.pike` genuinely have no inherits or imports, and the
rest depend only on `.h` headers or stdlib modules, both correctly excluded
from overlays.

## What the Per-Diagnose Dependency Refresh Costs

0.8.55 made diagnose compile a file together with its workspace dependencies,
and 0.8.56 stopped that re-reading each dependency's directory once per
dependency. The remaining question was whether the work that is left is sane
per keystroke at the tree's worst case.

didChange to the last `publishDiagnostics`, eight keystrokes each:

| File | Lines | Closure | min | p50 | max |
|---|---|---|---|---|---|
| `base_server/roxen.pike` | 8,347 | 17 | 1506 ms | **1517 ms** | 1683 ms |
| `modules/scripting/webapp.pike` | 2,011 | 10 | 755 ms | 761 ms | 767 ms |
| `base_server/snmpagent.pike` | 1,210 | 7 | 662 ms | 666 ms | 671 ms |
| `Variable.pmod/Image.pike` | 86 | 2 | 508 ms | 509 ms | 511 ms |

500 ms of every figure is the diagnostics debounce.

**Attribution.** The same file re-measured with no workspace root — which makes
the closure empty and removes the refresh entirely — gives p50 **1400 ms**
against **1517 ms** at closure 17. The dependency refresh costs **~117 ms on
the worst real closure in the tree**. The remaining ~900 ms is compiling an
8,347-line file, which this change did not introduce.

Distributions are tight across all eight samples with no drift, so this is
sane for interactive editing. Not a defect.

## Robustness at Scale

201,207 requests over 2,077 s, sweep exit 0.

- **Zero `error` records.** No handler crash, no unhandled rejection. The
  iteration-8 open Critical — the freed-tree hover crash, since guarded by
  `withBorrowedTree` — did not recur.
- **stderr was two lines**, both
  `[pike-worker] Discarding response for timed-out request`, matching the five
  `timeout` records. Nothing else.
- **Memory is flat.** 104 samples: server RSS mean 825 / 828 / 823 MB across
  the first, middle and last third of the run. Range 376–1,534 MB is the GC
  sawtooth; the run ended at 376 MB. The Pike worker stayed between 12 and
  60 MB.
- **The single Critical finding is not a defect.** It is five hover timeouts
  under sustained load. Re-run standalone three times, the reported position
  `modules/scripting/webapp.pike:8:8` answers correctly every time
  (`class XMLNSParser`, "Namespace aware parser") in 3428/1593/1384 ms
  including server startup. This is the worker-timeout nondeterminism
  iteration 8 documented.
- The known slow outlier persists unchanged: `textDocument/implementation`
  8,458 ms on `arg_cache_plugins/replicate.pike:4`, the same unbounded-work
  symptom iteration 7 recorded as D3.

## Defects Found

Neither came from the sweep.

1. **The dependency cap did not bound depth.** It compared against the number
   of overlays already emitted, but overlays are emitted post-order, so that
   count stays zero all the way down a chain — a 500-deep chain walked past 64
   and returned 500 overlays. Found by writing the test for the truncation
   warning. Latent rather than shipped-visible, since no real workspace has a
   chain that long. Fixed by counting on the way down.

2. **Completion offered protected and private members after `->` and `.` when
   the cursor was inside the declaring class.** Shipped and user-visible: the
   list contained members that resolve to 0 at run time. The rule the code
   implemented is not Pike's — verified against pike 8.0.1116 with real
   programs, `->` and `.` never expose a protected or private member in any
   context, including `this->prot()` inside the declaring class, `o->prot()` on
   another instance of the same class from inside that class, and inherited
   protected in a subclass. For `.` it is a compile error rather than a runtime
   zero, self-reference included. Two tests asserted the disproved behaviour
   and were corrected.

## Method to Carry Forward

**Measure the graph through the real server, and resolve dependencies first.**
Constructing a `WorkspaceIndex` directly skips Roxen detection and reports
119 edges instead of 859; skipping `ensureDependenciesResolved` reports zero.
Both look like plausible answers.

**Cross-check any graph claim with a second, independent extraction.** The
permissive textual pass is what turned "Roxen has no cycles" from a suspicious
result into an explained one.
