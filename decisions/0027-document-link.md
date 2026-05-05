# 0027: Document Link for Imports, Inherits, and Includes

**Status**: Accepted
**Date**: 2026-05-05
**Decision Maker**: Pike LSP team

## Context

Pike developers frequently navigate between files via imports, inherits, and include directives. Currently, clicking on `import Stdio;` or `#include "helper.pike"` does nothing in the editor — the developer must manually locate and open the target file.

The LSP `textDocument/documentLink` request allows servers to provide clickable links for URIs in the document. Pike has three linkable constructs:

1. **Import statements**: `import Stdio;` → navigate to Stdio module
2. **Inherit statements**: `inherit "path.pike"` or `inherit Stdio` → navigate to inherited file/module
3. **Include directives**: `#include "path"` → navigate to included file

The challenge: Pike's module resolution is complex. We must resolve paths correctly without executing Pike code.

## Decision

### Approach: Reuse ModuleResolver

The `ModuleResolver` class already implements Pike's module resolution algorithm:
- Resolves `Stdio` to the stdlib module file
- Resolves `Calendar.ISO` to the nested module
- Resolves relative paths like `"../lib.pike"` relative to the current file
- Handles `#pike` version-aware paths

**Decision**: Reuse `ModuleResolver.getCachedModule()` for synchronous resolution, falling back to `resolveModule()` for async resolution.

### Supported node types

| Node type | AST field | Resolution strategy |
|-----------|-----------|---------------------|
| `import_decl` | `path` | Module name → `getCachedModule()` or `resolveModule()` |
| `inherit_decl` | `path` (string literal) | Relative path → resolve from file directory |
| `inherit_decl` | `path` (identifier) | Module name → `getCachedModule()` |
| `preproc_include` | `string` child | Relative path → resolve from file directory |

### Handler implementation

1. Parse the document to get tree-sitter AST
2. Walk the tree looking for `import_decl`, `inherit_decl`, and `preproc_include` nodes
3. For each node, extract the path/module name
4. Resolve using `ModuleResolver.getCachedModule()` (sync) or `resolveModule()` (async)
5. Return `DocumentLink[]` with `target` set to the resolved URI (or omitted if unresolved)

### Non-resolved links

When a module or path cannot be resolved:
- The link is not added to the results
- The editor shows no link for that construct
- Future: could add a "not found" diagnostic, but that duplicates existing diagnostics

### Performance

- Synchronous: Uses `getCachedModule()` which is O(1) cache lookup
- Async: `resolveModule()` may involve filesystem I/O, but is still fast (< 50ms)
- No PikeWorker involvement — pure TypeScript filesystem operations

## Consequences

### Positive

- High daily value: Pike developers navigate imports constantly
- Reuses existing `ModuleResolver` infrastructure — no new path resolution code
- Fast: synchronous cache lookup for already-resolved modules
- Works for stdlib (Stdio, Calendar, etc.) and workspace modules

### Negative

- Relative path resolution for `inherit "path.pike"` is simplified — only handles `./` and `../` prefixes, not full relative path normalization
- Does not link to .pmod files that are directories (only `.pmod` files)
- No target URI for unresolved imports/inherits/includes

### Neutral

- `documentLinkProvider: { resolveProvider: false }` — we resolve targets during `onDocumentLinks`, no separate resolve request needed
- Links work only when the target file exists and is indexed/accessible