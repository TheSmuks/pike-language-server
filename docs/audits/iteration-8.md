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

> **Correction (2026-07-31, after this iteration was recorded).** This section
> measures *empty* results only, and the two `::` rows below are wrong because
> of it. The Roxen tier runs with `checker: undefined` (`cli.ts`) — Roxen's
> correct answers are unknown, so nothing checks them — which means **a
> confident wrong answer is recorded in the "answered" column**, not here.
> Read "1,847 empty" as "1,847 positions with no answer", never as "everything
> else was right". The corpus tier does have a checker; the Roxen tier's
> wrong-answer count is unmeasured, not zero. See the amendment at the end.

1,847 empty results, split by where the cursor is:

| | Records | Reachable from this repo? |
|---|---|---|
| Inside a `#define` body | 647 | ~~No~~ — wrong, see amendment 2 |
| `->` on a receiver | 936 | ~~Partly~~ — wrong, see amendment 3 |
| `Qualifier::` (mostly `predef::`) | 89 | ~~Needs Roxen index coverage~~ — wrong, see correction |
| Bare `::` | 74 | ~~Partly~~ — wrong, see correction |
| After `.` | 61 | Partly |
| Plain identifier | 24 | Yes |
| `->` on a subscript | 13 | Yes |

**~~The `#define` bucket is structural.~~ Wrong — see the amendment.** This
said the grammar makes an entire directive one opaque `preprocessor_directive`
token containing no identifier nodes, so nothing could answer inside it, and
that closing it meant parsing macro replacement lists in tree-sitter-pike.

The grammar already parsed them. `#define sQUERY(X,Y...) get_sdb()->query(X,Y)`
gives `preproc_define` → `identifier`, `preproc_params` → `preproc_param` →
`identifier`, `preproc_body` → four `identifier` nodes. It was true when the
sweep ran and stopped being true two commits later (`e9e262e`, `cc9f9a1`),
before this document was written. No tree-sitter work was needed.

**~~Most of the `->` bucket has no static answer.~~ Wrong — see amendment 3.**
The sampling below is accurate as far as it goes, but it characterises only the
empty results; the bucket's larger problem was ~1,900 wrong answers sitting in
the answered column. Sampling the receivers:

- ~140 have a real class type (`RoxenModule me`) — tractable, but the bundled
  Roxen index is built from Roxen's autodoc and does not carry the members in
  question (`RoxenModule.cvs_version` is absent). That is a change to
  `scripts/build-roxen-index.ts`, not to any lookup.
- ~69 are chains or call results (`id->misc->config_settings`).
- ~39 index a mapping. In Pike `m->key` *is* `m["key"]`; there is no
  declaration to point at, and hover/definition returning nothing is correct.
- ~29 are declared `object` with no class, and a further handful `mixed` or
  `object|void`. Pike cannot resolve these statically either.

**The two `::` rows were diagnosed wrong.** Attributing them to index coverage
took the "answered" column at face value. Probing every `::` site in the tree
instead of only the empty ones found the real defect: the qualifier was being
*ignored*, so `A::name` searched every inherit for a bare `name`. In
`RXML.pmod/PXml.pike` all twelve `low_parser::` expressions — `low_parser` is
an alias of the stdlib `Parser.HTML` — resolved into `RXML.pmod` instead.
Every one of them sat in the answered column, so none of them is in the table
above. Index coverage was a real but much smaller part of it (`predef::cache`).
Fixed in `6da9e3d`; see the amendment.

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

## Amendment — 2026-07-31, after this iteration was recorded

The measurements above are left as taken. What has changed since, and what was
wrong rather than merely superseded:

**Wrong: the two `::` rows, and the framing that produced them.** The Roxen
sweep has no checker, so it counts empties and errors and cannot see a wrong
answer at all. Reading the remainder as "what is left" therefore skipped the
worse defect. A targeted probe of *every* `::` site — answered ones included —
found the qualifier was being dropped whenever the enclosing program was the
file rather than a class, so `A::name` searched every inherit for a bare
`name`. Five further rules were modelled backwards, each settled against Pike
8.0.1116:

- An alias *replaces* an inherit's name. `inherit X.Y.Session : parent;` makes
  `Session::` an error, so `Session::timeout` in `HTTPClient.pmod` pointing
  into `Protocols.HTTP.Query` was a wrong answer that read as a right one.
- A surrounding class is a legal qualifier; the server had no notion of it.
- `this::`, `this_program::` and `local::` mean the program's *own*
  declaration first. All three were being read as a bare `::`, which is the
  one qualifier that skips it, so all three answered the inherited symbol.
- A nested class may name an enclosing class's inherit, but a bare `::` there
  is program-local.
- Hover was blank on `::` itself and on every qualifier keyword.

Fixed in `6da9e3d`. Across the tree's `::` sites, hover on the qualifier went
30 → 53 answered and on the member 99 → 107. **Definition went 92 → 83, which
is the fix working**: the thirteen it lost were all pointing at the wrong
class. That is the shape to expect whenever a wrong answer is corrected, and
it is invisible to a sweep that counts empties.

**Superseded, not wrong.** These were accurate when recorded and have since
been closed: the open Critical (the freed tree — `withBorrowedTree` now guards
five sites, `6d3219d`); `predef::report_fatal` and `RoxenModule.cvs_version`
absent from the bundled index (`a45bf0f`); `predef::cache` absent (`6da9e3d`).

**Method to carry forward.** Give the Roxen tier a way to see wrong answers,
or stop describing its remainder as though empties were the whole of it. Until
then, probe answered positions too — reading what the server *said*, not only
whether it said anything, is what surfaced all six defects.

## Amendment 2 — the `#define` bucket, 2026-07-31

Also wrong, and for a second reason on top of the stale grammar claim: the
bucket was never one thing. Probing all 5,842 identifier positions inside
Roxen's `#define`s — the sweep only ever visited the empty ones — splits the
2,940 with no hover into three unrelated causes:

| Cause | Count | Verdict |
|---|---|---|
| Macro parameters — the `X` and `Y` of `#define LOC_M(X,Y) …` | 1,831 | Fixed |
| Pike keywords (`if`, `while`, `string`, `return`) | 618 | Correctly empty |
| Names bound at the expansion site, or `->` on an untyped receiver | 491 | Not a `#define` problem |

**The parameters were being skipped on purpose.** `collectPreprocDefineRefs`
had an explicit `if (parameters.has(name)) continue`, reasoning that resolving
them against the enclosing scope would point them at unrelated declarations
sharing the name. That reasoning is right — Pike's preprocessor substitutes
textually, so with `int X = 100;` and `#define F(X) (X + X)`, `F(1)` is 2 — but
the remedy left 1,831 positions answering nothing rather than answering
correctly. A function-like `#define` now opens a scope of its own holding its
parameters, so they resolve to themselves and shadow the file exactly as the
preprocessor does. 1,831 → 0, no position regressed (`b8c153f` diffed
position-by-position; the single flip re-ran identically on a worktree of the
previous commit, per the determinism note above).

**The 618 keywords are not defects.** A macro body has no keyword positions for
the lexer, so `if` and `while` arrive as `identifier` nodes; hover on a keyword
correctly answers nothing. Any future count of this bucket should exclude them
rather than carry them as findings.

**The 491 remainder belongs to the other two clusters.** `#define ENC_ADD(X) …
res->res += …` refers to a `res` local to whichever function expands it, and
`FD->set_blocking()` is `->` on a macro parameter. Neither has a static answer,
and Pike does not have one either without expanding at each call site.

So the "third of the remaining findings that needs grammar work" was, in the
end, a scope the symbol table was declining to build.

## Amendment 3 — the `->` bucket, 2026-07-31

Wrong in the same way as the other two, and for the same reason: the sweep sees
only empty results, and this bucket's real problem was on the answered side.

Probing all 24,646 `->` positions in Roxen 6.1 — the sweep visited 936 of them —
and classifying by the receiver's declared type:

| Receiver | Answered before | Answered after | |
|---|---|---|---|
| declared class | 5,149 | **6,445** | Roxen's own classes now indexed |
| mapping / multiset | 1,761 | **141** | had no member to point at |
| string / int / float | 508 | **294** | same |
| array | 67 | **83** | automap now modelled |

Four defects, none of them the "index coverage" the table above blamed:

1. **Go-to-definition asked the name-based resolver first.** The cross-file
   fallback searches the inherit chain by bare name with no knowledge of the
   receiver, and it ran *ahead* of the type-driven resolver. Any same-named
   symbol reachable from the file pre-empted the receiver's own class.
2. **`findDeclUri` compared declarations by `id`.** That is a per-file counter,
   so a cross-file member came back with the target file's line and column
   under the *calling* file's URI. Reordering (1) is what exposed it — the
   answer had always been reachable, just never reached.
3. **Containers and primitives answered.** `m->foo` is `m["foo"]`; `s->size`
   does not compile. 1,620 positions pointed at unrelated declarations.
   `array` is the exception: `->` on one automaps to the element's member.
4. **`RequestID` had no members.** Roxen's request object — the receiver at 847
   `->` positions, more than any other type — is declared in `prototypes.pike`
   and injected as a global, so nothing led the resolver to it.

Total answered falls 10,396 → 9,803, which is the point: ~1,900 wrong answers
removed, ~1,300 correct ones added. A sweep that counts only empties records
that as a regression.
