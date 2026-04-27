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
| **Lambda closure** | Lambda body sees enclosing scopes. Captures are implicit — no capture list. |
| **Implicit this** | Inside class methods, bare `member` resolves to class member if no local matches. |

### Out of scope (Phase 4+)

- Import resolution (`import Stdio;` makes `Stdio.File` available)
- Cross-file inheritance (`inherit "/path/to/file.pike";`)
- Stdlib resolution (pike-ai-kb)

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

**Policy: Lazy rebuild on next request.** When a document changes (`didChange`), invalidate the cached symbol table. The next `textDocument/definition` or `textDocument/references` request triggers a rebuild.

This is the simplest correct policy. The symbol table build cost is proportional to file size (single tree walk), which is sub-millisecond for typical Pike files. Eager rebuild on every keystroke wastes cycles on intermediate states. Debouncing adds complexity for no measurable gain at Pike file sizes.

The existing `didChange` handler already re-parses on every change. The symbol table build piggybacks on the parse result — no additional parse needed.

## Pike Validation Strategy

The harness will extend `introspect.pike` to emit:
1. **Class body members**: For each top-level class, instantiate and `indices(instance)` → member names
2. **Per-member kinds**: `functionp()`, `programp()`, `intp()` etc. on class instance members

This validates the symbol table's declarations, not references. The LSP compares its tree-sitter-extracted declaration list against Pike's runtime symbol list for each scope.

## Gaps Relative to Pike's Scoping

| Gap | Impact | Mitigation |
|-----|--------|-----------|
| No macro expansion | `#define` names won't resolve | Document in known-limitations. Phase 6+ could add macro tracking. |
| No type inference for `->` access | `obj->method()` can't resolve if obj type unknown | For Phase 3, only resolve when obj is a same-file variable with known class type. |
| Variables have no line in `Program.defined` | Can't validate variable line numbers against Pike | Accept. Tree-sitter's positions are correct for well-formed code. |
| Preprocessor conditionals | Tree-sitter sees both `#ifdef` branches | Tree-sitter's ERROR-node handling already covers this — both branches are visible in the tree. The active branch determination would require running the preprocessor. |
| Auto-generated `__INIT` | Not in source, not in tree-sitter tree | Don't surface to user. |
| Implicit `this->` for members | Bare `member` in class method is class member | Resolution walks to class scope after checking locals — correct behavior. |

## Consequences

- The symbol table is tree-sitter-based, which means it's fast (single walk), deterministic, and works on any parse tree (including error-containing files — partial results).
- Pike validates declarations but not references. Reference resolution correctness depends on the scope chain implementation being correct — tested via the layer-1 test suite against Pike-validated declaration sets.
- The symbol table structure supports future Phase 4 cross-file resolution: `import` and `inherit` declarations can be annotated with external scope references without changing the core data structure.
