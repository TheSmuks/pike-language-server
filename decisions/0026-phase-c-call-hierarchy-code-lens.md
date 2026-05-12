# Decision 0026: Phase C — Call Hierarchy and Code Lens

**Date**: 2026-05-12
**Status**: Accepted

## Context

Phase A (transport) and Phase B (editing quality) are complete. Phase C adds
navigation features that help developers understand code structure and call
relationships.

## Decisions

### Call Hierarchy

Implements three LSP requests:
- `textDocument/prepareCallHierarchy`: finds the innermost function/method at cursor
- `callHierarchy/incomingCalls`: uses `getCrossFileReferences()` to find all callers
  across the workspace, groups by calling function
- `callHierarchy/outgoingCalls`: walks the tree-sitter AST within the function range,
  finds `call_expression` nodes, resolves each callee to its definition

Self-references are excluded from incoming calls to avoid noise.

### Code Lens

Shows reference counts above function and method declarations. Uses the workspace
index's `getCrossFileReferences()` to count references, excluding the declaration
itself. The lens command (`pike.showReferences`) can be wired to the references
provider in the client extension.

Code lens does NOT require a resolve provider — the count is computed at request
time.

## Consequences

- Call hierarchy requires a populated workspace index — returns empty for
  single-file workspaces or unindexed files.
- Code lens reference counts are approximate — they count symbol name matches
  in scope, not verified call targets. This is acceptable for a Tier-3 LSP.
- Both features add minimal performance overhead since they reuse existing
  workspace index data structures.
