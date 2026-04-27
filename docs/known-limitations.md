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
