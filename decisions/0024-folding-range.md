# 0024: Folding Range

**Status**: Accepted
**Date**: 2026-05-04
**Decision Maker**: Pike LSP team

## Context

The LSP `textDocument/foldingRange` request lets clients collapse/expand regions of code. Pike has several natural folding boundaries: class bodies, blocks, comment groups, and import blocks.

Tree-sitter-pike parses Pike source into a well-structured AST. The question is which node types should produce folding ranges.

## Decision

### Supported node types

| Node type | Folding behavior | Rationale |
|-----------|------------------|----------|
| `class_body` | Fold entire class body | Standard class-level collapse |
| `block` | Fold block contents | Functions, if/else bodies, catch blocks |
| `comment` group | Fold adjacent comments | Multi-line comment blocks |
| `program` | No fold | Top-level has nothing to fold into |

### Implementation

1. Walk the tree-sitter parse tree
2. For each qualifying node (class_body, block, comment sequence), compute the range from the first token to the last token
3. For comment groups: collect consecutive `comment` nodes and create a single folding range covering the group
4. Return `FoldingRange[]` sorted by start position

### Edge cases

- Empty class bodies or blocks produce no folding range
- Nested folds are allowed — the LSP client decides which to apply
- Pike's `#ifdef`/`#if`/`#else`/`#endif` blocks are covered by `block` folding

## Consequences

### Positive

- Uses tree-sitter structure directly — no PikeWorker needed
- Class_body folding is the most useful — collapse entire class to see only the class declaration
- Comment group folding handles doc comments and multi-line block comments

### Negative

- `block` is generic — applies to all blocks including `if`/`else`/`while` bodies; some clients prefer more specific fold types
- No `region` folding for `#ifdef` blocks (not tracked separately in the AST)

### Neutral

- The `kind` field is optional in LSP; not using it preserves compatibility with basic LSP clients
- Performance is O(n) in AST nodes — acceptable for files up to ~10,000 lines
