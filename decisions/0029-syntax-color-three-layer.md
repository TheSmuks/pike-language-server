# 0029 — Three-Layer Syntax Color Responsibility Split

**Date:** 2026-06-02
**Status:** Accepted
**Supplements:** 0002 (tier-3 boundary), 0014 (audit remediation), 0018 (incremental parsing), 0020 (semantic tokens), 0028 (lint layer)
**Context:** PR #95 "cover Pike BNF syntax highlighting cases" pushed grammar-shaped rules into the TextMate grammar, producing false-positive `])` coloring in `foo(arr[i])` and `f(g(x[i]))`. The grammar had the right nodes for the job; PR #95 used the wrong layer. This ADR records the correct routing.

## Decision

Syntax color in this LSP has exactly three layers, each with a single, distinct responsibility. Construct-by-construct, the routing is decided in this fixed order:

1. **Does the construct need special color at all?** Many constructs (plain `,`, `;`, `?:`) are fine as default punctuation. "Drop the special scoping entirely" is the most common correct answer.
2. **If yes, can the TextMate grammar match it *unambiguously on a single line*, with no parse context?** Then it belongs in `client/syntaxes/pike.tmLanguage.json`. Examples: `int`, `string`, function-call identifier (the `write(` pattern), numeric literals, string escapes.
3. **If no, the AST already disambiguates.** The construct belongs in `server/src/features/semanticTokens.ts`, keyed on a real tree-sitter node type. The walk reuses the singleton `Parser` and incremental tree cache (ADR-0018). Ranges are converted through `util/positionConverter.ts` so we don't reintroduce the `.end.character` audit-class bug.
4. **If the grammar cannot express the construct,** the gap is an **upstream issue against `tree-sitter-pike`**, not a TextMate regex. Track it in `docs/known-limitations.md` with the upstream issue URL.

The Pike oracle is not currently on the color hot path. Type-derived token enrichment (e.g., resolved-type overlays) is a future feature and is **not** a justification for context-dependent TextMate regex today.

## The Three Layers

| Layer | File | Role | What it never does |
|-------|------|------|--------------------|
| 1. TextMate (t0 paint) | `client/syntaxes/pike.tmLanguage.json` | Coarse, instant, zero-latency baseline. Paint at t0. | Anything requiring parse context. Anything that mirrors the Pike BNF. |
| 2. Tree-sitter semantic tokens (t1 paint) | `server/src/features/semanticTokens.ts` | Context-dependent classification from the actual parse tree. | Anything that requires the Pike subprocess. |
| 3. Pike oracle (t2 paint) | `server/src/features/pikeWorkerProcess.ts` | Type-derived enrichment when available. | Blocking first paint. Absent gracefully when slow. |

## Per-construct verdicts (PR #95's scope)

| Construct | PR #95 verdict | Correct verdict | Why |
|-----------|----------------|-----------------|-----|
| `({ 1, 2 })` array literal | TextMate `literal-delimiters` | **Tree-sitter semantic token** on `array_literal` node | Regex has no parse context; `([` collides with array indexing |
| `(< 1, 2 >)` multiset literal | TextMate `literal-delimiters` | **Tree-sitter semantic token** on `multiset_literal` | Same |
| `([ "k": v ])` mapping literal | TextMate `literal-delimiters` | **Tree-sitter semantic token** on `mapping_literal` | Same — and this is where the false positive is most visible |
| `({})`, `([])`, `(<>)` empty aggregates | TextMate `literal-delimiters` | **Tree-sitter semantic token** on the same node types | Same |
| `` `+ ``, `` `[]= ``, `` `() ``, `` `-> `` operator-name identifiers | TextMate `entity.name.function.operator.pike` | **Keep in TextMate** | Backtick operator names are unambiguous on one line. The regex never has a false-positive collision. This is a correct use of the TextMate layer. |
| `obj->name` arrow access | TextMate `punctuation.accessor.arrow.pike` + `variable.other.property.pike` | **Keep in TextMate** | `->` cannot appear in any other context. The member-name color is the existing baseline. The semantic-token layer additionally emits a method-shaped token for unresolved member access (already does this). |
| `obj.name` dot access | TextMate `punctuation.accessor.dot.pike` + `variable.other.property.pike` | **Keep in TextMate** | Same — but with a narrower regex than today to avoid matching decimal numbers. |
| `(int)x` cast | TextMate `storage.type.pike` inside `(...)` | **Drop the special scoping** | A type-cast `(int)x` is a `(type) expression`. Coloring `(int)` as a type is correct, but the rule is also active for plain parenthesized type expressions like `(int) + x`. This is a known false positive but a long-standing one, and the rule does not *misclassify* the type as a delimiter the way the literal-delimiters rule does. We keep the existing TextMate rule as-is; this is out of scope for PR #95's defects. |
| Compound assignment `+=`, `-=`, `*=`, `/=`, `&=`, `\|=`, `^=`, `<<=`, `>>=`, `%=` | TextMate `keyword.operator.pike` | **Keep in TextMate** | Longest-alternatives regex (the existing comment in the rule documents the ordering requirement) — this is a correct TextMate use, no parse context needed. |
| Splice `@`, range `..`/`...` | TextMate `keyword.operator.pike` | **Keep in TextMate** | Single tokens, no ambiguity. |
| `Foo::bar` scope access | TextMate `punctuation.accessor.scope.pike` | **Keep in TextMate** | `::` cannot appear anywhere else. |

## Why tree-sitter, not `highlights.scm`

`server/src/highlights.scm` already exists but is not loaded by anything. The LSP semantic-token layer emits a small, fixed, numeric vocabulary (10 types × 6 modifiers). For that vocabulary a typed `Cursor.walk()` keyed on node type with a `switch` is:

- easier to test (a unit test can construct a `Tree` from a 6-character fixture, not load a `.scm` parser)
- cheaper to maintain when the legend changes (changing the legend means changing the `switch`, not the `.scm` and the binding code)
- same cost at runtime (the walk is bounded by token count, not by query planning)

The `.scm` file stays in the repo as documentation of the grammar's highlight surface for other tools (Neovim, Helix, GitHub), but is not in the LSP critical path. We document this in the file's header comment.

## Semantic-token type/modifier vocabulary

The 10 existing types and 6 modifiers cover what we need with no additions. Verdict per PR #95 target:

- **Aggregate literals** use a *new* `decorator` shape? No. After review, they don't need any new type — `array_literal`/`multiset_literal`/`mapping_literal` nodes don't carry a separate identifier; the *enclosing punctuation* is what was miscolored, and that punctuation is now classified by the absence of a TextMate rule. We let TextMate's `punctuation` rule paint it as default punctuation. The aggregate-ness is recoverable from the surrounding `array_literal`/`multiset_literal`/`mapping_literal` node shape, but adding a `decorator` type for it would mean inventing a new selector that no theme styles. We **drop** the special scoping for aggregate delimiters and add a comment in the grammar saying "aggregate literal delimiters are default punctuation; classification is done by tree-sitter at the enclosing `array_literal`/`multiset_literal`/`mapping_literal` node, and that node is in the parse tree, not a token on its own."
- **Operator-name identifiers** keep the existing `entity.name.function.operator.pike` TextMate scope and stay in TextMate.
- **Member access** keeps existing TextMate scopes; the semantic-token layer keeps emitting a method-shaped token for unresolved members (this is already wired).

## Two-speed degradation

- **Server stopped:** TextMate-only baseline. Operators, keywords, comments, strings, types, function calls, classes, scope access, member access, operator-name identifiers all paint correctly. Aggregate-literal delimiters paint as default punctuation (acceptable).
- **Server up, tree-sitter only (no Pike):** Same as above, plus semantic-token overlays for declarations, references, and now aggregate-literal node spans (the enclosing node, not the delimiters).
- **Server up, Pike available:** All of the above, plus oracle-derived modifiers (`deprecated`, resolved `type` overlays in the future).

No flicker, no disappeared tokens, no crashes. The tree-sitter path is the same code path that powers documentSymbol/hover/folding; if the tree parses, the semantic tokens are produced.

## Implementation status (2026-06-02)

This ADR is **accepted** and the architectural decision stands. The
implementation completed in this commit:

1. The `literal-delimiters` TextMate rule was removed from
   `client/syntaxes/pike.tmLanguage.json` and the `tmLanguage-tokenization`
   test was inverted to assert the rule is absent.
2. `docs/known-limitations.md` gained an entry pointing at the upstream
   grammar issue.

The AST-layer replacement (`collectLiteralNodeSpans()` walker in
`server/src/features/semanticTokens.ts`) was prototyped and tested in
isolation but **was not committed** because the walker's tests exposed a
deeper upstream issue: `web-tree-sitter` 0.26.8 (and possibly the
tree-sitter-pike WASM build) leaks node text across back-to-back parses
of disjoint source strings. A direct repro is in
`harness/__tests__/web-tree-sitter-leak.test.ts` (added in this commit)
and the test was observed to fail with `text` from the prior source on
the second `parser.parse()`. Filing the upstream issue is the next
step; until it is resolved, the AST-layer walker cannot be safely
shipped in production. The TextMate retreat is the durable fix for the
user-visible PR #95 regression.

## Acceptance criteria (testable)

1. `foo(arr[i])`: the substring `])` is **not** painted as an aggregate delimiter. (The mapping at `(line 0, char 8..9)` is not in any TextMate `literal-delimiters` match.)
2. `({ 1, 2 })`, `(< 1 >)`, `([ "k": v ])`, and the empty forms `({})`, `([])`, `(<>)` parse to dedicated `array_literal` / `multiset_literal` / `mapping_literal` nodes that the tree-sitter walk can identify.
3. `` `+ ``, `` `[]= ``, `` `() ``, `` `-> `` match `entity.name.function.operator.pike` in TextMate (no regression).
4. Compound assignment `+=`, splice `@`, range `..`/`...` all match `keyword.operator.pike` with no longest-prefix bug.
5. Server stopped: TextMate-only baseline renders. No regression in any pre-PR-#95 test.
6. Server up: tree-sitter walks the same parse tree that `documentSymbol` and `hover` use. No reparse, no extra subprocess.
7. Position ranges go through `util/positionConverter.ts` so a multi-byte character (e.g. `é` in a string) is not split.
8. Existing tree-sitter consumers (documentSymbol, definition, references, folding, completion, signatureHelp, hover, backgroundIndex, lint) are not modified.

## Consequences

**Positive:**
- PR #95's false-positive `])` disappears.
- Aggregate-literal classification is no longer a "best-effort regex" — it is the parse tree.
- The TextMate grammar shrinks by one rule and becomes more honest about what it can do.
- Future BNF coverage flows through one path (semantic tokens) instead of two (TextMate regex + tree-sitter).

**Negative:**
- The aggregate-literal shape is no longer visibly colored as a "delimiter" — themes that did style it will fall back to default punctuation. This is the correct outcome per the routing rule above; documenting it in the grammar is sufficient.
- The semantic-tokens handler must now have access to the parse tree (it currently only has the symbol table). One new `parse(source, uri)` call inside `handleSemanticTokens`, using the same singleton + cache as the rest of the server.

## References

- `client/syntaxes/pike.tmLanguage.json` lines 188–196 (the `literal-delimiters` rule being removed)
- `server/src/features/semanticTokens.ts` (where the new walk plugs in)
- `server/src/util/positionConverter.ts` (the only place UTF-8 ↔ UTF-16 conversion lives)
- `server/src/parser.ts` (the singleton + LRU tree cache the new walk reuses)
- `docs/known-limitations.md` (where any grammar gap gets an upstream issue URL)
