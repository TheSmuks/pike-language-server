# Decision 0009: Per-file Symbol Resolution Architecture

**Date:** 2026-04-27
**Status:** Accepted
**Context:** Phase 3 — same-file symbol table, go-to-definition, find-references

## Decision

Build a per-file symbol table from the tree-sitter parse tree. Use tree-sitter for reference resolution. Use Pike as oracle to validate the symbol table's declaration list, not individual reference resolutions (Pike cannot provide per-position resolution).

## Symbol Table Data Structure

The symbol table is an immutable snapshot, computed once per parse-tree change. Pattern: build new, replace old, never mutate.

```typescript
interface SymbolTable {
  /** URI of the source file. */
  uri: string;
  /** Version of the document when this table was built. */
  version: number;
  /** All declarations in the file, with scope info. */
  declarations: Declaration[];
  /** All reference sites in the file. */
  references: Reference[];
  /** Scope tree: file → class → function → block → lambda. */
  scopes: Scope[];
}

interface Declaration {
  name: string;
  kind: "function" | "class" | "variable" | "constant" | "enum" | "enum_member" | "typedef" | "parameter" | "inherit";
  /** Position of the name identifier. */
  nameLoc: Location;
  /** Full range of the declaration. */
  range: Range;
  /** Scope that contains this declaration (scope ID). */
  scopeId: number;
  /** For classes: child declarations (members). */
  children?: number[]; // Declaration IDs
}

interface Reference {
  name: string;
  /** Position of the reference. */
  loc: Location;
  /** What kind of reference: bare name, call, member access, scoped access, etc. */
  kind: "identifier" | "call" | "arrow_access" | "dot_access" | "scope_access" | "type_ref" | "this_ref" | "label";
  /** Declaration this resolves to (null if unresolved / external). */
  resolvesTo: number | null; // Declaration ID
  /** Confidence: high = local/parameter/class, medium = inherited, low = preprocessor */
  confidence: "high" | "medium" | "low";
}

interface Scope {
  id: number;
  kind: "file" | "class" | "function" | "lambda" | "block" | "for" | "foreach" | "if_cond";
  /** Range of the scope in the source. */
  range: Range;
  /** Parent scope (null for file scope). */
  parentId: number | null;
  /** Declarations in this scope. */
  declarations: number[]; // Declaration IDs
  /** For class scopes: inherited scopes (from inherit_decl). */
  inheritedScopes?: number[]; // Scope IDs
}

interface Location {
  line: number;
  character: number;
}
```

## Scope Rules Implemented

### Scope hierarchy (innermost → outermost)

1. Lambda/foreach parameters
2. Lambda body local declarations
3. Enclosing block local declarations (walk up through block nesting)
4. Local function parameters (if inside a nested function)
5. Local function body locals
6. Enclosing function parameters
7. Enclosing function body locals
8. Class own members (all — no ordering within class scope)
9. Inherited members (walk inherit chain, same file only)
10. File-scope declarations (top-level)

### Special scope rules

| Rule | Description |
|------|-------------|
| **No hoisting** | Variables visible only after declaration statement. Parameters visible throughout function body. |
| **Block scope** | Variables in `if`/`for`/`while`/`foreach` bodies die at `}`. `for` init decl scoped to for body. `if` condition decl scoped to consequence + alternative. |
| **Class scope is flat** | All class members mutually visible regardless of source order. Class compiled as a unit. |
| **Inheritance** | `inherit A` brings A's public/protected members into B's scope. `::name` resolves to parent version. `ClassName::name` resolves to named ancestor. |
| **Shadowing** | Inner scope declarations shadow outer. Parameters shadow outer. First match wins in scope walk. |
| **Lambda closure** | Lambda body sees enclosing scopes. Captures are implicit — no capture list. Capture is by reference (Pike semantics verified: lambda sees current value at call time, not definition time). |
| **Implicit this** | Inside class methods, bare `member` resolves to class member if no local matches. |
| **Inherit with rename** | `inherit Animal : creature;` stores `Animal` as path name and `creature` as alias. `creature::member` resolves through the alias. Go-to-def on either path or alias resolves to the target class. |

### Out of scope (Phase 4+)

- Import resolution (`import Stdio;` makes `Stdio.File` available)
- Cross-file inheritance (`inherit "/path/to/file.pike";`)
- Stdlib resolution (pike-ai-kb)

### Pike-verified scoping behaviors

These behaviors were verified against Pike 8.0.1116. The LSP matches Pike's behavior for all of these:

| Case | Pike behavior | LSP behavior | Match? |
|------|--------------|-------------|--------|
| For-init variable inside loop | Visible (scoped to for body) | Scoped to for-scope | Yes |
| For-init variable after loop | Undefined (not in scope) | Resolves to outer declaration or null | Yes |
| Catch block variables | Scoped to catch block | Not tracked (tree-sitter-pike#3) | N/A |
| `this` in class method | Returns class instance | Resolves to class declaration | Yes |
| `this_program` in class method | Returns class program | Resolves to class declaration | Yes |
| Lambda captures outer variable | Sees current value at call time (by reference) | Resolves to outer declaration via scope chain | Yes |
| Forward reference to later class member | All members mutually visible | Class scope is flat | Yes |
| Forward reference to later class constant | Compiles and resolves correctly | Class scope is flat | Yes |
| Mutual recursion (A calls B, B calls A) | File scope has no ordering | File scope returns first match | Yes |
| `inherit Animal : creature` alias | `creature::member` resolves through inheritance | Scope chain finds inherit by alias | Yes |
| `creature::name` where `name` is overridden | Returns current class's value (Pike's `::` semantics) | LSP resolves to inherited scope's declaration | Correct for navigation (user wants to see the parent definition) |

## Reference Node Types

| Tree-sitter node | Pike syntax | Resolution strategy |
|-------------------|-------------|-------------------|
| `identifier_expr` | `x` | Scope chain lookup |
| `scope_expr` | `::foo`, `A::foo` | Inherit lookup → member |
| `id_type` in `type` | `Color c` | Scope chain lookup (class/enum/typedef) |
| `postfix_expr` (call) | `foo()` | Resolve callee → scope chain |
| `postfix_expr` (arrow) | `obj->method()` | Resolve obj type → class member |
| `this_expr` | `this`, `this_program` | Resolve to enclosing class_decl |
| `inherit_decl` path | `inherit A;` | Resolve to same-file class_decl |
| `break`/`continue` label | `break outer;` | Walk scopes for labeled_statement |

## Macro Handling

**Policy: Ignore.** Tree-sitter does not expand macros. `#define` constants appear as bare identifiers at the reference site, but the macro definition is a `preprocessor_directive` node with no tree-sitter-accessible structure.

Known limitation documented in `docs/known-limitations.md`. References to macro-defined names will not resolve. This is acceptable for Phase 3 — the gopls and rust-analyzer LSP servers also cannot resolve macro-expanded identifiers without custom per-macro logic.

## Cache Invalidation

### Trigger

Document change (`textDocument/didChange`). Each `didChange` notification deletes the cached symbol table entry from `symbolTableCache` (a `Map<string, SymbolTable>` keyed by URI). No partial invalidation — the entire table is discarded.

### What is cached

The full `SymbolTable` object for each open document: all declarations, references, and scopes for one file. Cached as a single entry per URI. No per-scope or per-symbol granularity.

### Rebuild timing

Lazy: the table is NOT rebuilt on `didChange`. Instead, the next `textDocument/definition` or `textDocument/references` request triggers a rebuild via `getSymbolTable()`. This function:
1. Checks the cache for the URI.
2. If present, returns the cached table.
3. If absent, re-parses the document text and builds a new symbol table.

The rebuild is a single tree walk — sub-millisecond for typical Pike files (<1000 lines).

### In-flight requests

In-flight requests see the table that was cached when they started. A `didChange` notification that arrives during a request does NOT invalidate the table mid-request, because:
- LSP notifications are processed sequentially (JSON-RPC ordering).
- The `didChange` handler deletes the cache entry but does not cancel in-flight requests.
- The next request after `didChange` will rebuild.

### Lifecycle

| Event | Action |
|-------|--------|
| `didChange` | Delete cache entry |
| `definition`/`references` request | Rebuild if cache miss, return cached if hit |
| `didClose` | Delete cache entry, clear diagnostics |
| `shutdown` | Clear entire cache |

### Rationale

Eager rebuild on every keystroke wastes cycles on intermediate states. Debouncing adds complexity for no measurable gain at Pike file sizes. The lazy-rebuild policy is the simplest correct approach: stale data is never served (cache is invalidated synchronously on `didChange`), and rebuild cost is negligible.

The existing `didChange` handler already re-parses on every change for diagnostics. The symbol table build piggybacks on the parse result — no additional parse needed.
## Pike Validation Strategy

### Class extraction via `indices(instance)`

The harness uses `introspect.pike` to extract class body members by instantiating each top-level class and calling `indices(instance)`. This approach works only when classes can be safely instantiated with no-argument constructors.

#### Corpus files with classes

| Corpus file | Instantiable? | Constructor args | Members extracted |
|-------------|--------------|-----------------|------------------|
| `class-create.pike` | Yes | None | `create`, `buf` |
| `class-multi-inherit.pike` | Yes | None | Inherited + own members |
| `class-single-inherit.pike` | Yes | None | `create`, `name`, `sound`, `describe`, `get_name` |
| `class-this-object.pike` | Yes | None | `name`, `add`, `build`, `self_ref`, `own_type` |
| `class-virtual-inherit.pike` | Yes | None | Virtual inherited members |
| `class-forward-refs.pike` | Yes | None | `compute`, `multiply`, `get_factor` |
| `class-inherit-rename.pike` | Yes | None | `label`, `describe`, `get_value`, `who`, `value` |
| `err-undef-member.pike` | No — compile error | — | Not in validation set |
| `err-undef-class.pike` | No — compile error | — | Not in validation set |

All valid (non-error) corpus classes are instantiable with no-argument constructors. Error corpus files are excluded from Pike validation entirely.

#### Phase 5 alternative for non-instantiable classes

Real-world Pike classes often require constructor arguments. Phase 5 will need reflection-based extraction that doesn't require instantiation:

1. **`program` introspection**: `indices(program_obj)` returns member names without instantiation.
2. **`compile_string` + `master()->handle_inherit`**: Compile a stub that inherits the target class and extract members from the stub program.
3. **`Tools.AutoDoc`**: Pike's built-in documentation system can extract member signatures from program objects.

The current no-arg instantiation approach is sufficient for the corpus. The program-reflection approach will be implemented when Phase 5 adds cross-file workspace indexing.

### Validation scope

The harness validates the symbol table's **declarations** (names, kinds, scope membership), not individual reference resolutions. Pike has no API for per-position reference resolution. The LSP compares its tree-sitter-extracted declaration list against Pike's runtime symbol list for each scope.

## Gaps Relative to Pike's Scoping

| Gap | Impact | Mitigation |
|-----|--------|-----------|
| No macro expansion | `#define` names won't resolve | Document in known-limitations. Phase 6+ could add macro tracking. |
| No type inference for `->` access | `obj->method()` can't resolve if obj type unknown | Phase 3 gap. Requires type inference engine (Phase 5+). |
| catch expression in assignment context | tree-sitter-pike loses `catch_expr` in `mixed err = catch { }` | Filed tree-sitter-pike#3. Workaround: none. Catch blocks are opaque to the LSP. |
| for_statement missing field names | `childForFieldName('initializer')` returns null | Filed tree-sitter-pike#2. Workaround: positional child scanning. |
| while/switch/do-while block scoping | Variables leak to enclosing scope | Filed tree-sitter-pike#4. Workaround: add per-construct handlers. |
| Variables have no line in `Program.defined` | Can't validate variable line numbers against Pike | Accept. Tree-sitter's positions are correct for well-formed code. |
| Preprocessor conditionals | Tree-sitter sees both `#ifdef` branches | Both branches visible in tree. Active branch requires preprocessor. |
| Auto-generated `__INIT` | Not in source, not in tree-sitter tree | Don't surface to user. |
| Implicit `this->` for members | Bare `member` in class method is class member | Resolution walks to class scope after checking locals — correct. |

## Consequences

- The symbol table is tree-sitter-based, which means it's fast (single walk), deterministic, and works on any parse tree (including error-containing files — partial results).
- Pike validates declarations but not references. Reference resolution correctness depends on the scope chain implementation being correct — tested via the layer-1 test suite against Pike-validated declaration sets.
- The symbol table structure supports future Phase 4 cross-file resolution: `import` and `inherit` declarations can be annotated with external scope references without changing the core data structure.
