---
title: tree-sitter-pike
created: 2026-05-15
updated: 2026-05-15
type: entity
tags:
  - tree-sitter
  - parser
sources:
  - raw/articles/architecture.md
---

# tree-sitter-pike

Tree-sitter grammar for the Pike programming language, providing fast incremental syntactic parsing.

## Overview

- **Version**: v1.2.2
- **Location**: `/tank/appdata/pike-dev/projects/tree-sitter-pike`
- **Implementation**: C++ with WASM support for editor integration

## Capabilities

Tree-sitter-pike delivers fast, error-tolerant syntactic parsing used across multiple LSP features:

- **Linting**: Syntax-level errors detected without invoking the Pike runtime.
- **Navigation**: Go-to-definition, find-references, and symbol outline driven by the syntax tree.
- **Completion triggers**: Identifies completion contexts (member access, function arguments, etc.) from partial parses.

## Known Issues

- **Issue #18 (fixed)**: Bare function calls (e.g., `foo()` without a receiver) were previously misparsed. This has been resolved in the current version.

## Relationships

- [[pike]] -- The Pike programming language this grammar targets.
- [[tier-3-lsp]] -- The LSP scope relying on tree-sitter-pike for syntactic analysis.
- [[two-speed-diagnostics]] -- Diagnostic strategy that leverages tree-sitter for fast syntactic checks while deferring semantic analysis.
- [[semantic-tokens]] -- Semantic token provider using tree-sitter DeclKind as input.
