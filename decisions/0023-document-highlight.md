# 0023: Document Highlight

**Status**: Accepted
**Date**: 2026-05-04
**Decision Maker**: Pike LSP team

## Context

The LSP `textDocument/documentHighlight` request lets clients highlight all references to the symbol under the cursor. Pike has three kinds of highlights: read (variable read, parameter use), write (assignment, `+=`, etc.), and declaration (the definition itself).

The server already has a `SymbolTable` that tracks all declarations and references. The question is how to distinguish reads from writes for a given location.

## Decision

### Node-type based classification

Use the tree-sitter AST to classify each reference:

| Reference kind | AST context | HighlightKind |
|----------------|-------------|---------------|
| Declaration | `declaration` parent node | Read (also marks declaration) |
| Write reference | `=` in assignment, `+=`, `-=`, etc. in assignment target | Write |
| Read reference | All other contexts | Read |

### Handler implementation

1. Accept `textDocument/documentHighlight` at server initialization
2. On request: find declaration at cursor via `getDefinitionAt()`
3. Collect all same-file references to that declaration via `getReferencesTo()`
4. For each reference, walk up the tree-sitter node to determine if it appears in a write context (assignment target, compound assignment target)
5. Return `DocumentHighlight[]` with the computed `kind` for each reference

### Scope

- Same-file references only — cross-file highlighting requires multi-file workspace coordination that is out of scope for this decision
- No PikeWorker involvement — purely tree-sitter based for sub-20ms latency

## Consequences

### Positive

- Fast, deterministic highlighting using existing symbol table infrastructure
- Declarations are self-highlighted (useful for "mark occurrences" style behavior)
- Write detection covers compound assignments, incremented declarations, etc.

### Negative

- Cross-file references are not highlighted (out of scope)
- Complex write contexts (e.g., `x = y` where `x` is a member) require walking up the tree

### Neutral

- The handler is purely synchronous — no async calls needed
- Highlight is a client-side feature; server just provides ranges and kinds
