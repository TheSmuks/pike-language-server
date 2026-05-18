# Changelog

All notable changes to the Pike Language Server project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]

### Changed

  - **Syntax highlighting**: Expanded TextMate grammar (`client/syntaxes/pike.tmLanguage.json`)
    from 6 patterns (comments + strings only) to 21 patterns covering keywords
    (control flow, declaration, other), modifiers, type keywords, built-in constants,
    preprocessor directives, operators, and punctuation. Keywords, types, operators,
    and constants are now colorized immediately on file open with zero indexing delay.
    Previously only comments and strings were highlighted.

- **Removed build artifacts**: `out/pike-language-server-*.vsix` and scratch
    files `test2.md`, `test-changelog.md` are no longer tracked by git.

  - **pike-fmt upgraded to v0.1.5**: Uses npm semver (`^0.1.5`). The npm package
    bundles `tree-sitter-pike.wasm` in `dist/`. `.pmod` files are now discovered
    by `pike-fmt` ([TheSmuks/pike-fmt#17]). `scripts/fmt.sh` sets `PIKE_FMT_WASM`
    to bypass a bundled-`__dirname` bug in `dist/cli.js` ([TheSmuks/pike-fmt#16]).
    A `postinstall` script (`scripts/postinstall-pike-fmt.js`) symlinks
    `web-tree-sitter.wasm` into `dist/` for the bundled tree-sitter runtime.

### Added

  - **pike-fmt integration**: `scripts/fmt.sh` wrapper and `fmt:check`/`fmt:write`
    npm scripts for formatting Pike source files in the repo. CI checks formatting on
    every push/PR via the `pike-fmt` job in `.github/workflows/ci.yml`.
  - **tree-sitter highlights for Neovim/Helix**: `queries/highlights.scm` provides
    syntax highlighting queries for nvim-treesitter and Helix via tree-sitter.
    Captures include `@keyword.import` for inherit/import, `@function.method`,
    `@variable.parameter`, `@constant`, and `@preproc`.

  - **TextMate grammar test**: `harness/__tests__/tmLanguage.test.ts` validates
    that the grammar JSON contains all required keyword patterns.

  - **languageConfiguration test**: `tests/lsp/languageConfiguration.test.ts`
    validates that `language-configuration.json` is valid JSON with all required keys.

  - **Skipped cross-file completion test**: `tests/lsp/completion.test.ts` includes
    a skipped test for cross-file inherited member completion, referencing the
    known limitation entry in `docs/known-limitations.md`.

  - **Open Issues tracked**: `TRACKING.md` Open Issues table now tracks
    TextMate grammar tokenization coverage and cross-file inherited member completion.

  - **tree-sitter workarounds annotated**: `server/src/features/declarationCollector.ts`
    now includes `TODO(tree-sitter-pike#2)` and `TODO(tree-sitter-pike#4)` markers
    on the remaining tree-sitter-pike grammar workarounds.

  - **Cross-file inheritance gap documented**: `docs/known-limitations.md` now
    documents that `Dog d; d->` returns only same-file members when `Dog`
    inherits from a cross-file class.

  - **AI agent scaffolding documented**: `CONTRIBUTING.md` now includes an
    "AI Agent Scaffolding" section describing `.omp/skills/` conventions.

  - **Neovim/Helix highlights documented**: `docs/other-editors.md` now includes
    setup instructions for nvim-treesitter and Helix tree-sitter queries.

### Fixed

  - **computeWasmHash returns null on unreadable WASM**: `computeWasmHash()` in
    `server/src/features/persistentCache.ts` returned `"unknown"` when the WASM
    file was unreadable, which defeated cache matching on every server restart
    (every new hash failed to match the `"unknown"` sentinel).  Returns `null`
    instead; callers now skip cache save/load when the hash is unavailable.

  - **Cache load is per-entry resilient**: A single corrupt symbol table entry in
    the on-disk cache would delete the entire cache file.  `server.ts:onInitialized`
    now wraps each entry's `deserializeSymbolTable()` call in `try/catch` and
    logs a warning, skipping only the corrupt entry and restoring the rest.

  - **pikeCache size estimation avoids JSON.stringify**: Replaced the hot-path
    `JSON.stringify(entry).length` in the Pike diagnostic LRU cache `estimateSize`
    callback with a cheap estimator: `entry.contentHash.length` plus per-diagnostic
    overhead.  Eliminates GC pressure during active editing (debounce fires
    every 500ms).

  - **scopeBuilder synthetic ID counter avoids Math.max spread**: `wireInheritedScopes()`
    used `Math.max(...table.declarations.map(d => d.id))` which overflows the JS
    call stack for files with >100K declarations.  Replaced with
    `table.declarations.reduce((max, d) => Math.max(max, d.id), 0)`.

  - **workDoneProgress on slow provider capabilities**: `referencesProvider` and
    `workspaceSymbolProvider` now declare `workDoneProgress: true` in their
    capability objects so clients can show progress for long-running operations.

  - **CI: bun audit step**: Added `bun audit` to the CI `test` job before the
    Pike build step, closing the security audit gap.

  - **CI: coverage reporting**: `bun test` in CI now runs with `--coverage`
    for coverage data upload.

  - **Removed stray initParser() from server.ts**: Eliminated the fire-and-forget
    `void initParser()` call in `createPikeServer()` that served no purpose
    (the real init happens in `onInitialized`).

  - **sigHelp.second-param SKIP → PASS**: `resolveSignature()` in
    `server/src/features/signatureHelp.ts` was looking up the class scope
    with `table.scopes.find(s => s.declarations.includes(classDecl.id))`.
    `Dog`'s `scopeId` is the file scope, not the class scope, so this
    returned the file scope — which does not contain `create`'s ID. The
    `createDeclId` was always `undefined`, causing the constructor lookup
    to fall through to stdlib (no `predef.Dog`) and return `null`.
    Fix: use `findClassScope(table, classDecl)` from `typeResolver.ts`,
    which correctly finds the class body scope via `kind === 'class'`
    and range containment.

  - **textDocument/references respects includeDeclaration**: The `onReferences`
    handler now adds the declaration location to the results when
    `params.context.includeDeclaration` is `true`, in both cross-file and
    same-file paths with duplicate-avoidance logic.

  - **documentLink fallback for unresolvable modules**: `collectInheritLink`
    in `documentLink.ts` now emits a `pike://modules/...` link even when the
    module cannot be resolved, instead of silently omitting the link.

  - **health-check.ts test suite**: Fixed 6 needle/position issues and 1 test
    structure error in the LSP health-check test file (`tests/health-check.ts`):
    `refs.method`, `refs.parameter`, `rename.prepare-valid`, `rename.execute`,
    `highlight.variable`, `hover.variable-type`, and `codeAction.unused-var`.


## [0.3.3-beta] — 2026-05-05
## [0.3.5-beta] — 2026-05-06
