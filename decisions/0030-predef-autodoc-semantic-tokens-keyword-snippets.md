# ADR 0030: Predef Builtin Documentation, Semantic Tokens, and Keyword Snippets

**Status**: Accepted
**Date**: 2026-05-28
**Scope**: Hover, completion, semantic tokens

## Context

An audit of Pike LSP editing quality features identified three high-impact gaps:

1. **Predef builtins had no documentation** — hover and completion showed only type signatures (e.g., `function(string, mixed:void)`), with no human-readable description. 283 C-level predef functions were opaque to users.

2. **Semantic tokens classified all unresolved identifiers as `variable`** — predef builtins like `write`, `sprintf`, `search` and stdlib modules like `Sql`, `Protocols` all appeared as plain variables in syntax highlighting, losing visual distinction.

3. **No keyword completions** — typing `if`, `for`, `foreach`, `class`, `lambda` etc. offered no snippet assistance. Users had to type the full construct manually.

## Decision

### 1. Predef autodoc extraction (P1–P4)

Extract predef builtin documentation from Pike's own `core_autodoc.xml` (shipped with Pike 8.0.1116 at `/usr/local/pike/8.0.1116/doc/src/core_autodoc.xml`). Generate a static JSON index (`server/src/data/predef-autodoc.json`) at build time containing:

- `signature`: cleaned Pike type signature
- `markdown`: human-readable documentation text
- `params`: named parameter list with types and descriptions
- `returnType`: return type description

Coverage: 204 of 283 predef builtins have documentation in Pike's XML. The remaining 75 are undocumented in Pike itself.

The autodoc index is loaded at startup via `loadPredefAutodocIndex()` (mirroring the existing stdlib autodoc pattern), stored in `ServerContext`, and wired into hover and completion contexts.

**Hover**: `buildPredefHoverMarkdown` appends documentation markdown, parameter descriptions, and return type when an autodoc entry exists.

**Completion**: `collectPredefBuiltinItems` uses named params from autodoc for snippet tab stops (e.g., `write(${1:fmt})` instead of `write(${1:void|string})`).

### 2. Semantic token classification for external symbols (H-6/H-8)

`produceSemanticTokens` accepts an optional `externalLookup` parameter with two Sets:

- `predefBuiltins`: names from the predef builtin index
- `stdlibModules`: top-level module names extracted from stdlib FQNs

Unresolved identifier references are classified:

| Matches           | Token type | ID  |
|-------------------|------------|-----|
| Predef builtin    | `function` | 3   |
| Stdlib module     | `namespace`| 8   |
| Neither           | `variable` | 5   |

The lookup is built lazily via `getExternalLookup()` with a cache that resets on index reload.

### 3. Keyword snippet completions (P5)

A curated `KEYWORD_SNIPPETS` array provides 23 snippet completions for Pike keywords that benefit from structural expansion:

- **Control flow**: `if`, `else`, `else if`, `for`, `foreach`, `while`, `do`, `switch`, `case`, `default`
- **Exceptions**: `catch`
- **Declarations**: `class`, `enum`, `typedef`, `constant`
- **Lambda**: `lambda`
- **Import/inherit**: `inherit`, `import`
- **Special**: `gauge`, `sscanf`, `typeof`

Type keywords (`int`, `string`, `array`, ...) and modifiers (`private`, `static`, ...) are excluded — they are too short to benefit from snippets and would pollute the completion list.

Keywords sort at priority 60 (after all symbol completions at 0–50) so identifiers, functions, and modules always appear first. Keywords are skipped if their name collides with an already-seen identifier.

## Consequences

- **User experience**: Hover on `write()` now shows actual documentation. Typing `if<TAB>` expands to a complete if-block. Predef functions and stdlib modules are visually distinct in syntax highlighting.
- **Bundle size**: `predef-autodoc.json` adds ~100KB to the server bundle.
- **Maintenance**: Predef autodoc is derived from Pike's XML. When Pike version changes, the extraction script should be re-run. The 75 undocumented builtins will gain docs only when Pike upstream adds them.
- **No pike worker dependency**: All new features use pre-built static data, maintaining the existing design goal of zero pike-worker round-trips for common completions and hover.
