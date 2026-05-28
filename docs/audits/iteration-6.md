# Audit Iteration 6 — Syntax Highlight, Formatting, Code Move, Completion, Std Help

Date: 2026-05-29

Scope: Four-area audit of editor-facing features plus improvement plan for Pike std help on completion and hover.

## Finding Summary

| Severity | Count |
|----------|-------|
| High     | 4     |
| Medium   | 7     |
| Low      | 5     |
| **Total** | **16** |

---

## Area 1: Syntax Highlighting (Semantic Tokens)

### Architecture

Two-layer highlighting:
- **TextMate grammar** (`client/syntaxes/pike.tmLanguage.json`, 339 lines) — static pattern-based: keywords, strings, numbers, comments, operators, declarations, member access
- **LSP semantic tokens** (`server/src/features/semanticTokens.ts`) — symbol-table-driven: declarations (class, enum, enumMember, function, method, variable, parameter, type, namespace)

### Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| S1 | M | `builtinFunction` custom token type declared in `extension.package.json:59-65` but never emitted by server. Predef builtins rendered as plain `function` | `semanticTokens.ts:29` TOKEN_TYPES lacks `builtinFunction`; `semanticTokens.ts:258-264` emits index 3 |
| S2 | M | `mutable` custom modifier declared in `extension.package.json:66-71` but never emitted. No way for themes to distinguish mutable vs readonly variables | `semanticTokens.ts:51` TOKEN_MODIFIERS lacks `mutable` |
| S3 | L | `deprecated` modifier wired in code (`semanticTokens.ts:127-129`) but `isDeprecated` never passed from `produceSemanticTokens()`. Dead logic path | `semanticTokens.ts:211` — `isDeprecated` not provided |
| S4 | L | Dead file `server/src/highlights.scm` (87 lines) — tree-sitter highlight queries never consumed | Not imported anywhere |
| S5 | L | No regexp literal highlighting in either TextMate or semantic tokens | Pike `regexp()` calls parsed as function calls |
| S6 | M | No semantic token delta or range support — full recomputation every time | `serverCapabilities.ts:40-43` — only `full: true` |
| S7 | L | No unit tests for semantic tokens — only health-check validates non-empty results | `tests/health-check.ts:310-337` |

### What Works Well

- Clean DeclKind-to-token mapping with method promotion for class-scoped functions
- TextMate grammar is comprehensive (keywords, types, modifiers, comments, strings, numbers, preprocessor, autodoc tags)
- `parameter` token type for function parameters (not just catch-all variable)
- `readonly` modifier on constants
- `static` modifier on class members

---

## Area 2: Code Formatting

### Architecture

- **Formatter engine**: `pike-fmt` imported in-process (NOT a subprocess)
- **Full-document formatting**: `textDocument/formatting` via `formattingHandler.ts` (215 lines)
- **On-type formatting**: `textDocument/onTypeFormatting` triggers on `}` and `;`
- **Configuration**: `insertFinalNewline` (default true), `operatorSpacing` (default false, Phase 1 is indentation-only)

### Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| F1 | M | No `documentRangeFormatting` — explicitly listed as not implemented | `docs/known-limitations.md` row 5 |
| F2 | L | Stale documentation: `docs/known-limitations.md` says "shells out to `pike-fmt`" but code imports in-process | `formattingHandler.ts:19` vs `known-limitations.md:6,11` |
| F3 | M | `operatorSpacing` config exists but Phase 1 formatter is indentation-only. Setting has no effect | `docs/known-limitations.md` row 3 |

### What Works Well

- In-process formatter avoids subprocess overhead and PATH dependency
- On-type formatting uses minimal diff edits (`computeOnTypeEdits`)
- Proper incremental tree-sitter parse on format changes
- Language configuration (`language-configuration.json`) provides indentation rules, bracket matching, auto-closing pairs, comment continuation

---

## Area 3: ALT+ARROW Code Move

### Architecture

- Extension overrides VSCode default ALT+UP/DOWN for Pike files
- Custom wrapper: `editor.action.moveLinesUpAction` → detect change → `editor.action.formatDocument`
- Rationale: VSCode regex-based indentation rules can't track block nesting; pike-fmt handles re-indentation correctly

### Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| M1 | M | Moving lines across `#if`/`#endif` preprocessor boundaries may produce incorrect indentation (tree-sitter-pike limitation) | `docs/known-limitations.md` row 2 |
| M2 | L | Full document format triggered on every line move — potential latency for large files | `client/extension.ts:360-381` |

### What Works Well

- Custom wrapper with format-after-move ensures correct indentation when crossing block boundaries
- Tree-sitter incremental parsing handles line swaps correctly
- `computeOnTypeEdits` properly diffs (fixed from earlier index-corruption bug)
- Multiline strings/comments safe (formatter preserves body content)
- Keybinding scoped to Pike files only (`editorLangId == pike`)

**Verdict**: This area is solid. The only real risk is preprocessor boundaries, which is an upstream issue.

---

## Area 4: Autocompletion Suggestions

### Architecture

Multi-file architecture:
- `completionTrigger.ts` — trigger detection (dot, arrow, scope, call_args, unqualified)
- `completion.ts` — main dispatch, priority-sorted results
- `completion-items.ts` — declaration-to-CompletionItem conversion
- `completion-stdlib.ts` — stdlib secondary index, auto-import
- `completion-chain.ts` — chained call type resolution
- `completion-scopeAccess.ts` — `::` scope access
- `completion-callArgs.ts` — `(`-triggered argument snippets
- `completion-snippets.ts` — snippet parameter extraction
- `navigationCompletion.ts` — LSP registration + `completionItem/resolve`

### Priority Order

0: Local scope → 5: Type-resolved members → 10: Stdlib members → 15: Directory module → 20: Imported → 30: Predef builtins → 40: Stdlib top-level → 50: Auto-import → 60: Keyword snippets

### Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| C1 | H | `PikeWorker.resolve()` returns methods/constants/inherits for any Pike symbol but is NEVER called in completion or hover. Most significant untapped data source in the codebase | `pikeWorker.ts:250-264`, not imported in any completion/hover file |
| C2 | H | Stdlib member completion is prefix-only. `addStdlibMembers()` constructs `"predef." + lhsText` — works for `Stdio.File.` but NOT for `Stdio.File f; f->` (lhsText is "f") | `completion.ts:480-496` |
| C3 | M | Hover for qualified stdlib members broken. When hovering `f->open()` where `f` is `Stdio.File`, FQN lookup uses unqualified name `"predef.open"` instead of `"predef.Stdio.File.open"` | `hoverHandler.ts:220-251`, `hoverContent.ts:445-473` |
| C4 | M | Call-args completion scans all 5,471 stdlib entries linearly — O(n) on every `(` trigger | `completion-callArgs.ts` line 96 |
| C5 | M | 79 of 283 predef builtins (28%) lack documentation — only raw type signature shown | `predef-autodoc.json` coverage |
| C6 | L | Auto-import cap of 10 items may miss relevant stdlib symbols | `completion.ts:364` `AUTO_IMPORT_CAP = 10` |
| C7 | L | `isIncomplete` threshold at 50 items may cause client re-queries that return same results | `completion.ts:100` |

### What Works Well

- Well-structured multi-file architecture with clear separation
- Rich pre-rendered markdown for 5,471 stdlib entries and 204/283 predef builtins
- Auto-import with automatic `inherit` statement insertion
- Chained call type resolution up to depth 5
- Commit characters (`.`, `,` for functions; `.` for classes)
- Snippet support with parameter placeholders for all sources
- `completionItem/resolve` for lazy documentation loading
- Three-tier hover resolution (workspace autodoc → stdlib/predef → //! comments → bare signature)

---

## Improvement Plan: Pike Std Help on Completion and Hover

### Priority 1: Wire `PikeWorker.resolve()` into completion and hover

**Impact**: HIGH — unlocks runtime member resolution for ANY Pike type, including stdlib.

**For completion**: When type resolution fails to find a workspace class (e.g., `Stdio.File`), call `PikeWorker.resolve(typeName)` to get `methods` and `constants`. Convert to completion items with stdlib autodoc enrichment.

**For hover**: When hovering over a member of a stdlib-typed variable, use `PikeWorker.resolve()` to confirm the type, then look up `predef.TypeName.method` in `stdlibIndex` for rich docs.

**Implementation sketch**:
1. Add `resolve()` call to `completion.ts` strategy 3 fallback (after workspace type resolution fails)
2. Add `resolve()` call to `hoverContent.ts` Tier 2 fallback (when stdlib hash lookup by unqualified name fails)
3. Cache results per type name to avoid repeated subprocess calls
4. Respect existing cancellation tokens

### Priority 2: Fix stdlib member completion for typed variables

**Current**: `addStdlibMembers()` only works when `lhsText` matches a stdlib module path.

**Fix**: When strategy 3 resolves a variable's declared type (e.g., `Stdio.File`), use the resolved type name to look up stdlib children. Pipeline:
1. `resolveChainedType()` returns `"Stdio.File"`
2. Construct FQN `"predef.Stdio.File"` and look up in `getStdlibChildrenMap()`
3. Fall back to `PikeWorker.resolve("Stdio.File")` if not in index

### Priority 3: Fix hover FQN lookup for qualified stdlib members

**Current**: `resolveHoverBuiltin()` looks up `"predef." + name` where `name` is the unqualified identifier.

**Fix**: When `resolveAccessDeclaration()` resolves an access like `f->open` and the parent type is known, construct the full FQN `"predef.Stdio.File.open"` for stdlib index lookup.

### Priority 4: Activate `builtinFunction` semantic token

**Current**: Custom token type declared but never emitted.

**Fix**:
1. Add `"builtinFunction"` to `TOKEN_TYPES` array in `semanticTokens.ts:29`
2. In `produceSemanticTokens()`, check if identifier is in `ctx.predefBuiltins` — emit `builtinFunction` type instead of `function`
3. This gives themes a way to color predef functions differently from user-defined functions

### Priority 5: Improve predef autodoc coverage

**Current**: 79/283 predef builtins lack documentation.

**Fix**: Extract missing docs from Pike's `core_autodoc.xml` source. The extraction pipeline already exists — re-run with broader coverage. Alternatively, for the remaining 79, call `PikeWorker.autodoc()` on-demand as a Tier 2b fallback.

### Priority 6: Optimize call-args completion

**Current**: Linear scan of 5,471 stdlib entries.

**Fix**: Build a name-based reverse index (`Map<string, {fqn, entry}[]>`) from `stdlibIndex` at init time. Use it for O(1) lookup in call-args completion.

---

## Priority Matrix

| Priority | Finding | Effort | Impact |
|----------|---------|--------|--------|
| 1 | Wire PikeWorker.resolve() into completion/hover (C1) | Medium | HIGH |
| 2 | Fix stdlib member completion for typed variables (C2) | Medium | HIGH |
| 3 | Fix hover FQN lookup for qualified stdlib members (C3) | Small | HIGH |
| 4 | Activate builtinFunction semantic token (S1) | Small | Medium |
| 5 | Activate mutable semantic token modifier (S2) | Small | Low |
| 6 | Improve predef autodoc coverage to 283/283 (C5) | Medium | Medium |
| 7 | Optimize call-args completion index (C4) | Small | Medium |
| 8 | Add semantic token delta support (S6) | Large | Medium |
| 9 | Implement range formatting (F1) | Large | Medium |
| 10 | Activate deprecated modifier (S3) | Small | Low |
