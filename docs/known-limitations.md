# Known Limitations

## Resolved Upstream Issues

### ~~Unicode identifiers not parsed correctly~~ — RESOLVED

**Upstream issue**: [TheSmuks/tree-sitter-pike#1](https://github.com/TheSmuks/tree-sitter-pike/issues/1)

**Fixed in**: tree-sitter-pike commit `28a8ae8` — identifier grammar now uses `\p{L}` and `\p{N}` Unicode property escapes.

**LSP update**: WASM binary updated, test updated from "expects truncation" to "expects full Unicode identifier." No workaround code was needed — the LSP already handled partial results gracefully.

## Current Upstream Limitations

### catch expression lost in assignment context

**Upstream issue**: [TheSmuks/tree-sitter-pike#3](https://github.com/TheSmuks/tree-sitter-pike/issues/3)

When `catch { ... }` is used as the RHS of a local declaration assignment (`mixed err = catch { ... };`), the `catch_expr` node disappears from the parse tree. The expression hierarchy descends through `comma_expr > assign_expr > ... > rel_expr` and stops, never reaching the `catch` keyword.

**LSP impact**: Cannot create scopes for catch-block variables, resolve references, or provide diagnostics for the standard `mixed err = catch { ... }` pattern. Standalone `catch { ... }` works correctly.

**Workaround**: None. Consumers must treat catch blocks as opaque.

### Missing field names on for_statement children

**Upstream issue**: [TheSmuks/tree-sitter-pike#2](https://github.com/TheSmuks/tree-sitter-pike/issues/2)

`for_statement` and `for_init_decl` children have no field names assigned. `childForFieldName('initializer')` returns null.

**LSP impact**: The symbol table builder uses positional child scanning instead of field-based access. This is fragile but functional.

**Workaround**: Walk `for_statement.children` directly, checking `child.type === 'for_init_decl'`. For `for_init_decl`, scan children for `identifier` nodes.

### No scope-introducing nodes for while/switch/plain blocks

**Upstream issue**: [TheSmuks/tree-sitter-pike#4](https://github.com/TheSmuks/tree-sitter-pike/issues/4)

`while_statement`, `do_while_statement`, `switch_statement` have no field names or scope markers. Variables declared inside these constructs cannot be automatically scoped.

**LSP impact**: Block scoping works for `if`/`for`/`foreach` (explicit handlers) but not for `while`/`switch`/`do-while`. Variables declared inside these blocks currently leak to the enclosing scope.

**Workaround**: Add per-construct handlers similar to `collectIfStatement` for each remaining block-scoped statement type.

## Cross-File Resolution Limitations (Phase 4)

### No .so binary module resolution

The ModuleResolver skips `.so` (compiled C module) files. System modules that are pure C (e.g., `_Stdio`, `__builtin`) cannot be resolved by path lookup. This affects completion and go-to-definition for low-level system types.

**Mitigation**: Most commonly used stdlib modules (Stdio, Array, Mapping, etc.) are implemented in Pike (.pmod files) and resolve correctly. Pure C modules could be handled in a future phase via pike-ai-kb or a pre-built system module map.

### No joinnode multi-path merge

Pike's `joinnode` class merges symbols from multiple search paths when the same module name exists in multiple locations. The LSP uses first-match-wins instead. If a workspace contains a module with the same name as a system module, the workspace version takes precedence.

**Impact**: Rare in practice. Workspace modules overriding system modules matches user expectation.

### Import resolution is scoped to file-system paths

Import resolution searches workspace and system module paths. It does not query Pike at runtime. Dynamic module behavior (modules that register symbols at compile time) is not captured.

**Impact**: Low for standard Pike code. Dynamic modules are rare in user workspaces.

### .pmod directory contents not individually introspected by harness

The harness has snapshots for file-based `.pmod` modules (`cross_import_a.pmod`, `cross_lib_module.pmod`) with full symbol extraction from Pike. However, directory-based `.pmod` modules (`cross_pmod_dir.pmod/`) are not individually introspected.

**Corpus .pmod inventory:**
- `cross_import_a.pmod` — FILE (26 lines). Harness snapshot: YES. Ground truth: Pike oracle.
- `cross_lib_module.pmod` — FILE (22 lines). Harness snapshot: YES. Ground truth: Pike oracle.
- `cross_pmod_dir.pmod/` — DIRECTORY (2 entries: `module.pmod`, `helpers.pike`). Harness snapshot: NO. Not introspected.
- `cross_pmod_dir.pmod/module.pmod` — child of directory module. Harness snapshot: NO.
- `cross_pmod_dir.pmod/helpers.pike` — child of directory module. Harness snapshot: NO.

**What works:** File-based `.pmod` modules are fully tested via harness snapshots. The LSP's documentSymbol output for `cross_import_a.pmod` is compared against Pike's introspection.

**What's missing:** Directory module member enumeration. The LSP's cross-file tests only verify that `cross-pmod-user.pike` indexes successfully. They don't verify that the LSP discovers the same members from `cross_pmod_dir.pmod/` that Pike resolves. This is a semantic correctness gap.

**Phase 5 prerequisite:** Build `harness/resolve.pike` to introspect directory modules and cross-file member availability.