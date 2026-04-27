# Changelog

All notable changes to the Pike Language Server project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-alpha] - 2026-04-26

### Added

- Project initialized from ai-project-template.

## [Unreleased]

### Added

- LSP server: stdio transport, documentSymbol handler, text document sync
- Server factory: `createPikeServer(connection)` for in-process testing
- Tree-sitter integration: WASM parser (web-tree-sitter@0.26.8) with parse cache
- documentSymbol: 15 node type → SymbolKind mappings with nested class/enum support
- Parse error handling: partial results + diagnostics on ERROR nodes
- VSCode extension: activates on .pike/.pmod/.mmod files
- Harness: symbol extraction via Pike program introspection (indices/values/typeof)
- docs/lsp-references.md: architecture patterns + testing strategies
- Decision 0006: LSP server architecture

### Testing

- Three-layer test infrastructure:
  - Layer 1 (tests/lsp/): 227 protocol-level tests with in-process PassThrough transport
    - documentSymbol.test.ts: 213 tests comparing against harness snapshots
    - lifecycle.test.ts: 5 tests (initialize, shutdown, performance)
    - error-handling.test.ts: 8 tests (malformed input, KL-007, edge cases)
  - Layer 2 (tests/integration/): 3 test stubs for @vscode/test-electron
  - Layer 3 (MANUAL_SMOKE_TESTS.md): 3 manual UX items
- Tree-sitter unit tests: 108 (renamed to tree-sitter-symbol.test.ts)
- Total test suite: 403 tests, 4306 assertions

### Fixed

### Fixed

- snapshot.ts: type-safe generic diff (getField helper, no unsafe casts)

## Phase 3: Per-file Symbol Table - 2026-04-27

### Added

- Symbol table builder: two-pass construction (declarations + references, then inheritance wiring)
- Scope-aware resolver: 10-level scope hierarchy with chain walk
- textDocument/definition handler: go-to-definition for same-file symbols
- textDocument/references handler: find-references for same-file symbols
- Symbol table cache: lazy rebuild on next request after didChange
- Inherit-with-rename support: `inherit Animal : creature` with alias resolution
- 4 new corpus files: scope-for-catch, scope-shadow-params, class-forward-refs, class-inherit-rename
- 18 edge-case tests covering scoping, shadowing, forward refs, lambda captures
- Decision 0009 expanded: explicit cache invalidation policy, Pike-verified scoping behaviors table, class extraction documentation
- Upstream issues filed: tree-sitter-pike#2, #3, #4

### Fixed

- For-loop init declarations now register in for-scope (was empty due to tree-sitter missing field names)
- If-block consequence/alternative push their own block scope (variables no longer leak)
- Lambda scopes in variable initializers now discovered
- Scope tie-breaking prefers deeper scopes when ranges are equal
- Inherit-with-rename: scope_access resolves through alias, go-to-def on both path and alias

### Testing

- Phase 3 definition tests: 110 tests
- Phase 3 references tests: 29 tests
- Edge-case tests: 18 tests
- Total test suite: 614 tests, 5680 assertions, 0 failures
## [0.1.0-alpha] - 2026-04-26