# 0019: Type Inference Strategy

**Status**: Accepted
**Date**: 2026-04-30
**Decision Maker**: Pike Language Server team

## Context

Pike is a dynamically typed language. Most variables are declared without explicit type annotations (`mixed`, `auto`, or omitted entirely). The language server must still provide meaningful hover information, completion, and go-to-definition for these untyped variables.

Static analysis of Pike source via tree-sitter alone cannot resolve runtime types. The Pike runtime, however, can evaluate `typeof()` on any expression and return the actual type. The language server spans both worlds: tree-sitter for fast static analysis, and a Pike worker process for runtime type queries.

Three capabilities were added across US-008, US-009, and US-010:

1. **Assignment narrowing** — the `assignedType` field on `Declaration` records the callee or identifier name from a variable's initializer, enabling member-access resolution without runtime queries.
2. **PikeWorker typeof integration** — the `typeof_()` async method queries the Pike runtime for the type of an expression, used as a Tier 4 hover fallback for untyped variables.
3. **Depth-limited type resolution** — `resolveType` in `typeResolver.ts` chains through class hierarchies up to `MAX_RESOLUTION_DEPTH` (5), preventing infinite recursion on circular inheritance.

The question is: how should these mechanisms interact, what are their limits, and what should happen when they all fail?

## Decision

The language server uses a layered type inference strategy, ordered by cost and reliability.

### 1. Return type tracking

Functions and methods store their return type annotation (if present) in `Declaration.declaredType`, extracted from the `return_type` field of the tree-sitter function node. This is purely syntactic — no flow analysis is performed on the function body. If a function declares `: Dog` as its return type, `declaredType` is `"Dog"`. If no return type is annotated, `declaredType` is `undefined`.

**MUST**: Return type annotations on function declarations MUST be stored in `declaredType` exactly as written in source.

**SHOULD**: Callers resolving the type of a function call SHOULD look up the callee's `declaredType` and, if present, resolve it through `resolveType` to find the target class `Declaration`.

**MAY**: Return type inference from function bodies (analyzing `return` statements) MAY be added in a future phase but is not currently implemented.

### 2. Assignment narrowing via `assignedType`

For variable declarations (`variable_decl`, `local_declaration`) where the declared type is absent or `mixed`, the symbol table extracts the initializer expression's callee or identifier name and stores it as `assignedType` on the `Declaration`.

The extraction algorithm (`extractInitializerType`) drills through tree-sitter expression wrapper nodes — `comma_expr`, `assign_expr`, `cond_expr`, `postfix_expr`, `primary_expr`, `identifier_expr` — to find the innermost identifier. For call expressions (`makeDog()`), it extracts the callee name (`makeDog`). For simple references (`someVar`), it extracts the identifier name (`someVar`).

Key constraints:

- `assignedType` stores the **callee identifier name** (e.g., `"Dog"`, `"makeDog"`), not a resolved type. Resolution to a class `Declaration` happens at consumption time via `resolveType`.
- Extraction only runs when `declaredType` is absent or `"mixed"`. Explicitly typed variables (`Dog d = ...`) use `declaredType` directly.
- Identifiers matching `PRIMITIVE_TYPES` (`void`, `mixed`, `zero`, `int`, `float`, `string`, `array`, `mapping`, `multiset`, `object`, `function`, `program`, `bool`, `auto`, `any`) are rejected and produce `undefined`.

The member-access resolver (`findMemberTarget` in `symbolTable.ts`) uses `assignedType` as a fallback when `declaredType` is a primitive or absent: it first tries `declaredType` (if non-primitive), then falls back to `assignedType`, then searches for a class declaration matching that name.

**MUST**: `assignedType` MUST only be set for `variable` declarations where `declaredType` is absent or `"mixed"`. It MUST NOT overwrite a useful explicit type annotation.

**MUST**: `extractInitializerType` MUST reject identifiers in `PRIMITIVE_TYPES` to avoid storing uninformative type names.

**SHOULD**: Member-access resolution SHOULD prefer `declaredType` over `assignedType` when the former is non-primitive and resolvable.

**MAY**: `assignedType` MAY be set to a function name rather than a class name (e.g., `d = makeDog()` stores `"makeDog"`). Consumers must resolve the function's return type to get the actual class.

### 3. PikeWorker `typeof_()` integration

The `PikeWorker` class provides an async `typeof_(source: string, expression: string): Promise<TypeofResult>` method that sends the full source text and an expression name to the Pike runtime and receives back the evaluated type.

The `onHover` handler in `server.ts` uses this as Tier 4, after static hover (Tier 1–3) fails:

- **Eligibility**: Only `variable` or `parameter` declarations where `declaredType` is absent, `"mixed"`, or `"auto"`.
- **Execution**: `await worker.typeof_(source, decl.name)` — async, runs in the Pike worker process.
- **Display**: On success, the hover signature is annotated with `// inferred: <type>` and documentation shows `"Type inferred by Pike: \`<type>\`"`.
- **Failure**: If the worker is unavailable, times out, or returns `mixed`/error, the catch block falls through silently.

The key architectural tension: `declForHover` is synchronous (tree-sitter based), while `typeof_()` is async. The integration is in the `onHover` handler itself, which is `async`, allowing the `await` naturally.

**MUST**: The `typeof_()` call MUST be gated on `declaredType` being absent, `"mixed"`, or `"auto"`. Explicitly typed variables MUST NOT trigger a runtime query.

**MUST**: Worker errors and timeouts MUST be caught and silently suppressed — the user MUST receive tree-sitter hover as fallback, never an error from the worker.

**SHOULD**: The hover display SHOULD distinguish inferred types from declared types (via the `// inferred:` comment) so users know the source of the information.

**MAY**: The `typeof_()` method MAY be used for other features (diagnostics, completion) in the future, but currently only `onHover` consumes it.

### 4. Depth limits

`resolveType` in `typeResolver.ts` accepts a `depth` parameter (default 0) and returns `null` when `depth >= MAX_RESOLUTION_DEPTH` (5). This prevents infinite recursion on circular inheritance chains (e.g., `class A inherits B`, `class B inherits A`).

The resolution chain is: same-file class → cross-file class via inherit/import → qualified type via `WorkspaceIndex` → stdlib type via prefix index. Each recursive call increments depth.

**MUST**: `MAX_RESOLUTION_DEPTH` MUST be enforced on every recursive `resolveType` call. The function MUST return `null` when the limit is hit, not throw.

**SHOULD**: The depth limit SHOULD be documented alongside the constant so future maintainers understand the trade-off (5 was chosen as a reasonable maximum inheritance chain length for Pike codebases).

**MAY**: The depth limit MAY be made configurable via server settings if users encounter legitimate deep chains.

### 5. Fallback behavior

When all inference mechanisms fail — no `assignedType`, `resolveType` returns `null`, `typeof_()` unavailable or returns `mixed` — the language server falls back to tree-sitter-based hover from `declForHover`. This produces a basic hover showing the variable name and its declared type annotation (if any), or just the name.

The fallback chain in `onHover`:

1. **Tier 1**: Direct tree-sitter hover on the node.
2. **Tier 2**: Symbol table declaration lookup.
3. **Tier 3**: `declForHover` using `Declaration.declaredType`.
4. **Tier 4**: `PikeWorker.typeof_()` for untyped variables.
5. **Final**: Return `formatHover(declForHover(decl, uri))` — the basic tree-sitter hover.

**MUST**: The `onHover` handler MUST always return a hover result or `null`. It MUST NOT surface internal errors to the user.

**MUST**: When Tier 4 fails (worker error, timeout, `mixed` result), the handler MUST fall back to the Tier 3 result, not return `null` if a declaration was found.

## Consequences

### Positive

- Untyped variables get meaningful hover information in most cases without requiring explicit type annotations from the user.
- The layered approach means cheap static checks run first; the expensive Pike worker is only invoked when static analysis cannot determine the type.
- `assignedType` enables member-access resolution (arrow/dot completion, go-to-definition) for inferred types without runtime queries.
- Depth limiting prevents server hangs on pathological inheritance cycles.

### Negative

- `assignedType` stores identifier names, not resolved types. If the initializer function is renamed, the stored name becomes stale until the file is re-parsed. This is acceptable because tree-sitter re-parses on every edit.
- `typeof_()` sends full source text to the Pike worker on every hover for eligible variables. For large files, this is I/O-bound. The async nature prevents blocking, but latency may be noticeable.
- The `typeof_()` call is fire-and-forget on failure — no telemetry or logging. Silent failures make it hard to diagnose why inference isn't working in a specific file.
- Assignment narrowing only handles direct assignments (`Dog d = makeDog()`). It does not track reassignments, control flow, or multi-step assignments (`d = makeDog(); d = makeCat();`).

### Neutral

- `PRIMITIVE_TYPES` is the single source of truth for "unhelpful" declared types. Adding a new primitive requires updating this set; it is not derived from Pike's grammar.
- The `MAX_RESOLUTION_DEPTH` of 5 is a heuristic. Real-world Pike codebases rarely exceed 3–4 levels of inheritance, but the limit is not empirically validated.
- `typeof_()` is inherently a runtime query — results reflect the Pike runtime's type system, which may differ from tree-sitter's understanding (e.g., for `program` types, `sprintf` return types).

## Alternatives Considered

### Full data-flow analysis

Perform whole-program data-flow analysis to track variable types across assignments, branches, and function calls. This would produce more accurate types but requires building a full SSA or data-flow framework, which is out of scope for a language server that must respond in milliseconds. The current approach trades precision for speed and simplicity.

### Caching typeof results

Cache `typeof_()` results per (URI, variable name) pair and invalidate on edit. This would reduce repeated runtime queries on re-hover. Not chosen for the initial implementation because the Pike worker is already persistent and the overhead of cache invalidation complexity was not justified by observed latency. May be revisited if profiling shows `typeof_()` as a bottleneck.

### Assignment narrowing via resolved types

Instead of storing the callee name in `assignedType`, resolve it to the actual class `Declaration` at parse time and store the resolved declaration ID. This would eliminate the need for consumers to call `resolveType` on `assignedType`. Not chosen because it would create parse-time dependencies on the workspace index (cross-file resolution), complicating the symbol table build phase which is intentionally single-file.

### Hybrid approach with type annotations inference

Automatically insert `@type` JSDoc-like annotations based on inferred types, persisting them in the document or a sidecar file. Rejected because it would modify user files or require a sidecar infrastructure, and the current hover-only approach provides the information without persistence side effects.
