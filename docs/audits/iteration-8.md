# Audit Iteration 8 — Driving the Corpus Tier to Zero

Date: 2026-07-31

Scope: the behavioural sweep from [iteration 7](iteration-7.md), re-run and
worked down. Same harness, same two tiers — the 87-file semantic corpus and all
442 Pike files in Roxen 6.1.

## Headline Result

**The corpus tier is at zero.** 7,874 requests, 7,749 answered, 125 declined by
the server's own guards, and nothing else: no empty result, no wrong answer, no
error, nothing slow.

| Corpus tier | Iteration 7 (after its fixes) | Now |
|---|---|---|
| Findings | 28 | **0** |
| Empty results | 28 | **0** |
| Wrong answers | 0 | 0 |

The Roxen tier moved much less, and the reason is structural rather than
another round of the same work:

| Roxen tier | Before | After |
|---|---|---|
| Findings | 1,751 | **1,608** |
| Empty results | 1,992 | **1,847** |
| Errors | 1 | **0** |
| Distinct defects | 27 | 25 |

146 positions that answered nothing now answer. Every one of them is
completion; the rest of the Roxen remainder is characterised below and most of
it is not reachable from this repository.

## What Was Wrong

Every corpus finding was a position where the server had an answer and declined
to give it. Six unrelated root causes, none of them the same defect twice.

### Completion fell off a cliff at three ordinary cursor positions

The sweep probes the first column of every identifier. Completion worked one
column to the left and one to the right of those positions and returned an
empty list on the boundary itself.

- **Column 0** returned "no completion is possible here". There is no character
  before the cursor to read a trigger out of — which is not the same as there
  being nothing to complete.
- **A lone `:`** did the same, silencing completion after the value type of a
  mapping (`mapping(string:CacheEntry)`), a ternary's second arm, and every
  `case` label. Only `::` is a trigger, and the two-character check already
  handled it.
- **The start of an argument** landed in the call-args trigger, which read
  parameters out of `declaredType`. For a function declaration that field holds
  the *return* type, so the argument snippet had never once appeared for a
  function declared in the file — only for a variable holding a function type.
  The same defect silently disabled class-constructor snippets, since
  `create()` is a function declaration too.

The `(`-trigger also cannot tell a call from a parameter list, so
`string color_name(Color c)` offered an argument snippet for the function being
declared. A `(` whose parent is `parameters` is now never a call.

### Qualified completion never matched anything that parsed

`A::value()` reaches the handler as an `inherit_specifier` whose text is `A::`,
and the handler compared that against inherit *names*. It only ever worked on a
half-typed `Base::`, which does not parse and arrives as a bare identifier. So
every complete qualified expression in the corpus completed to nothing.

Three sibling gaps came out of the same investigation: `global::` was not known
to completion at all (the reference collector has resolved it to the file scope
since an earlier fix), `predef::` was not either, and bare `::` read only
`inheritedScopes` — which holds inherits wired to a class in the *same file*.
Roxen inherits a cross-file module or a stdlib class far more often, and for
those the list is empty.

### Highlight and references asked the wrong question

Both routed through `getDefinitionAt`, which answers what go-to-definition
asks — "where does this lead?" — and deliberately returns null for an inherit
or import naming another file, so navigation can resolve it cross-file.
Document highlight wants the opposite: the occurrence under the cursor, which
for `import Stdio;` is the word `Stdio` right there.

A renamed inherit had no range recorded for its alias at all, so `motor` in
`inherit "engine.pike" : motor;` matched no position query.

And a reference the file cannot resolve — a member of an imported module, a
macro from an include, `g->greet()` — was read as "no symbol here". Its uses in
this file are known, and they are what a document-local query asks for.
Matching is by name *and receiver*, so `a->greet()` and `b->greet()` stay
separate symbols. A dotted type now records its member segments too:
`Stdio.File` in type position answered nothing while the identical
`Stdio.File()` one line over resolved.

### The server went silent on its own answer

Hover and definition on `inherit NonExistentClass;` returned nothing — at the
one position the server itself hands out as the definition from every *use* of
that name in the file. The oracle confirms the file is invalid Pike, and the
server does report `Undefined identifier NonExistentClass.` for it; that is not
a reason for the declaration to become unreachable.

## What Remains on the Roxen Tier

1,847 empty results, split by where the cursor is:

| | Records | Reachable from this repo? |
|---|---|---|
| Inside a `#define` body | 647 | No — see below |
| `->` on a receiver | 936 | Partly |
| `Qualifier::` (mostly `predef::`) | 89 | Needs Roxen index coverage |
| Bare `::` | 74 | Partly |
| After `.` | 61 | Partly |
| Plain identifier | 24 | Yes |
| `->` on a subscript | 13 | Yes |

**The `#define` bucket is structural.** The grammar makes an entire directive
one opaque `preprocessor_directive` token — `#define sQUERY(X,Y...)
get_sdb()->query(X,Y)` contains no identifier nodes at all, so no
position-driven capability can answer anywhere inside it. Closing this means
parsing macro replacement lists in tree-sitter-pike; it is the same
macro-expansion family the parse triage put out of scope, and it is a third of
the remaining findings.

**Most of the `->` bucket has no static answer.** Sampling the receivers:

- ~140 have a real class type (`RoxenModule me`) — tractable, but the bundled
  Roxen index is built from Roxen's autodoc and does not carry the members in
  question (`RoxenModule.cvs_version` is absent). That is a change to
  `scripts/build-roxen-index.ts`, not to any lookup.
- ~69 are chains or call results (`id->misc->config_settings`).
- ~39 index a mapping. In Pike `m->key` *is* `m["key"]`; there is no
  declaration to point at, and hover/definition returning nothing is correct.
- ~29 are declared `object` with no class, and a further handful `mixed` or
  `object|void`. Pike cannot resolve these statically either.

`predef::` is the same shape as the `RoxenModule` case:
`predef::report_fatal` is a global roxenloader injects at run time, present in
neither the Pike builtin index nor the Roxen one. Completion after `predef::`
now offers Pike's 283 builtins, which is correct as far as it goes; the Roxen
globals need the index generator extended rather than the lookup guessing.

## One Open Critical

The first sweep recorded a single handler crash:

```
textDocument/hover  server/base_server/configuration.pike:563:26
  Request textDocument/hover failed with message:
  null is not an object (evaluating '(tree ?
```

The expression is `(tree ?? parse(doc.getText(), uri)).rootNode` in
`accessResolver.ts:123`. `parse()` cannot return null — it throws — so the null
`rootNode` points at a **tree that has already been freed**, which matches the
eviction hazard `parser.ts` documents on `treeCache.set()`.

It did not reproduce across two further sweeps of 200,936 requests each, so it
is rare and timing-dependent. It is recorded rather than papered over: adding a
null guard at the call site would convert a use-after-free into a silent wrong
answer and make the real defect harder to find.

## A Property of the Harness Worth Knowing

**The Roxen tier is not deterministic.** Two consecutive sweeps at the same
commit gave 1,971 and 1,990 empty results, with 7 positions flipping
empty→answered and 26 the other way. The Pike worker times out on some
requests, so anything needing runtime resolution can answer on one run and not
the next.

A 1–2% movement in a Roxen total therefore means nothing. Diff the ledgers by
(capability, file, position), and reproduce anything that looks like a
regression against a worktree of the previous commit before believing it —
`module.pike:72-82` looked like one this iteration and returned exactly the
same `null` on the pre-session baseline.

The corpus tier *is* deterministic: 28 → 11 → 3 → 0 tracked each fix exactly,
and a final re-run reproduced 0 from 7,874 records. It is the tier to verify a
fix against.

## Also Fixed

`scripts/lsp-probe.ts diagnostics` resolved on the first `publishDiagnostics`
for a URI. The server publishes twice — a parse-only pass right after didOpen,
then the Pike worker's verdict — so the tool printed `[]` for every file whose
only problem is semantic. `err-undef-class.pike`, whose entire purpose is to
inherit a class that does not exist, reported clean. It now settles on the last
set published.

The tool misled this investigation before it was caught, which is the argument
for fixing it rather than working around it.
