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
- Tree-sitter integration: WASM parser (web-tree-sitter@0.26.8) with parse cache
- documentSymbol: 15 node type → SymbolKind mappings with nested class/enum support
- Parse error handling: partial results + diagnostics on ERROR nodes
- VSCode extension: activates on .pike/.pmod/.mmod files
- Harness: symbol extraction via Pike program introspection (indices/values/typeof)
- 108 LSP tests: symbol comparison, parse errors, performance, canaries, determinism
- Decision 0006: LSP server architecture
- docs/lsp-references.md: architecture patterns from gopls, rust-analyzer, clangd
- Total test suite: 178 tests, 1256 assertions

### Fixed

- snapshot.ts: type-safe generic diff (no more unsafe casts)

## [0.1.0-alpha] - 2026-04-26