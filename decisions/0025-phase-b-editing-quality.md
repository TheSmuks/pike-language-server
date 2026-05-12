# Decision 0025: Phase B — Editing Quality Improvements

**Date**: 2026-05-12
**Status**: Accepted

## Context

Phase A established the transport and responsiveness foundation. Phase B targets editing quality — the features users interact with most directly during coding.

Four improvements identified:
1. Selection range (shrink/expand selection)
2. On-type formatting (auto-indent on `}` and `;`)
3. Completion textEdit (precise insertion ranges)
4. Completion snippets (function parameter placeholders)

## Decisions

### Selection Range
Pure tree-sitter AST walk. Walk from cursor position upward to root, collecting ranges for meaningful node types (declarations, blocks, expressions). Skip anonymous nodes and overly granular wrapper nodes to avoid noisy selections. New file `selectionRange.ts`.

### On-Trigger Formatting
Reuses the existing `pike-fmt` formatter but returns only the edits near the trigger line. For `}`, checks one line above (empty block case). For `;`, checks only the trigger line. Trigger characters: `}` (first), `;` (additional).

### Completion textEdit
Post-processing step in the `onCompletion` handler. Finds the identifier prefix range via tree-sitter and wraps each item's `insertText` in a `textEdit` with the correct replacement range. This prevents the "foo.bbar" doubling bug.

### Completion Snippets
For function/method declarations with a `declaredType` containing a Pike function type, parse the parameter list and generate LSP snippet tab stops (`${1:type}`). Only applied when `declaredType` is available — gracefully degrades to plain insertion for declarations without type info.

## Consequences

- Selection range enables VSCode's built-in shrink/expand selection for Pike.
- On-type formatting gives immediate visual feedback when closing blocks.
- Completion textEdit fixes the prefix-doubling bug for all completion sources.
- Snippets work for typed declarations; predef/stdlib functions get snippets only if they have type info.
