# Limitations Sprint — Fix Active Limitations & Patch Release

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Fix 6 active limitations, add adversarial tests, update docs, cut patch release.

**Architecture:** Each fix is self-contained in its own module or a focused patch to an existing module. The unifying principle is: tree-sitter provides the precise AST; Pike's error messages provide semantic text that can be matched to AST nodes. Where Pike lacks column data, we mine its error message text to locate the relevant token in the tree-sitter parse.

**Tech Stack:** TypeScript 5.x, tree-sitter-pike WASM, bun test

---

## Scope

| # | Limitation | Module | Approach |
|---|-----------|--------|----------|
| L1 | Call hierarchy outgoing calls broken | `callHierarchy.ts` | Search `postfix_expr` + `argument_list` instead of `call_expression` |
| L2 | Transitive inherit resolution (one-hop) | `workspaceResolution.ts` | Recursive resolve with cycle detection (max depth 10) |
| L3 | Complex initializer type inference | `scope-helpers.ts` | Handle `member_expr` (chain), index expressions, array/mapping constructors |
| L4 | Cross-file rename name-only matching | `workspaceResolution.ts` | Type-aware filtering for bare function/variable refs (not just arrow/dot) |
| L5 | Diagnostic columns — message-based precision | `diagnosticUtils.ts` | Parse Pike error message text to locate the exact token via tree-sitter |
| L6 | Integration test output channel skip | `tests/integration/` | File tracking issue, convert to manual smoke test entry |

---

## Task 1: Fix call hierarchy outgoing calls (L1)

**Objective:** Make outgoing calls work by matching tree-sitter-pike's actual AST node types.

**Files:**
- Modify: `server/src/features/callHierarchy.ts:202-262` (`collectCallExpressions`)
- Modify: `tests/lsp/callHierarchy.test.ts:349-392` (update the test)

**Step 1: Read the current `collectCallExpressions`**

Read `server/src/features/callHierarchy.ts` lines 180-320 to understand the full function and its callers.

**Step 2: Rewrite `collectCallExpressions` to match `postfix_expr` with `argument_list`**

In tree-sitter-pike, function calls at statement level parse as `postfix_expr` nodes that have an `argument_list` child. The callee is the named child before the `argument_list`.

Replace the `child.type === "call_expression"` check with:
```typescript
if (child.type === "postfix_expr" && child.childForFieldName("arguments")) {
  // The callee is the first named child (before the argument_list)
  const callee = child.child(0);
  ...
}
```

**Step 3: Update the test**

In `tests/lsp/callHierarchy.test.ts`, the test at line 352 currently asserts `expect(result).toEqual([])`. Update it to assert that the result contains the expected callee. The test code at lines 349-392 already creates a tree with a function call; update the assertion to verify the call is found.

**Step 4: Run the test**

```bash
bun test tests/lsp/callHierarchy.test.ts
```

**Step 5: Commit**

```bash
git add server/src/features/callHierarchy.ts tests/lsp/callHierarchy.test.ts
git commit -m "fix(call-hierarchy): resolve outgoing calls via postfix_expr nodes"
```

---

## Task 2: Add adversarial tests for call hierarchy (L1)

**Objective:** Verify edge cases don't break the outgoing calls fix.

**Files:**
- Modify: `tests/lsp/callHierarchy.test.ts`

**Step 1: Write tests for edge cases**

Add tests for:
1. Chained calls: `getDog()->bark()` — should show both `getDog` and `bark` as outgoing
2. Nested calls: `foo(bar())` — should show both `foo` and `bar`
3. Method calls with `this->`: `this->speak()` — should resolve `speak`
4. Multiple calls to the same function — deduplicated (seen set)
5. Empty function body — returns `[]`
6. Call with no arguments: `foo()` — still found

**Step 2: Run tests**

```bash
bun test tests/lsp/callHierarchy.test.ts
```

**Step 3: Commit**

```bash
git add tests/lsp/callHierarchy.test.ts
git commit -m "test(call-hierarchy): adversarial tests for outgoing calls"
```

---

## Task 3: Transitive inherit resolution (L2)

**Objective:** Follow inherit chains beyond one hop with cycle detection.

**Files:**
- Modify: `server/src/features/workspaceResolution.ts:280-308` (`resolveUnresolvedReference`)
- Add test cases in: `tests/lsp/crossFileOracle.test.ts` or create new test file

**Step 1: Read the current code**

Read `workspaceResolution.ts` lines 280-325 to understand `resolveUnresolvedReference`.

**Step 2: Add recursive resolution with cycle detection**

The current code does one hop: for each inherit/import declaration, resolve the target, check its declarations. The fix is to make it recursive:

```typescript
async function resolveUnresolvedReference(
  ctx: ResolutionContext,
  ref: Reference,
  table: SymbolTable,
  uri: string,
  visited?: Set<string>,
  depth?: number,
): Promise<{ uri: string; decl: Declaration } | null> {
  const MAX_DEPTH = 10;
  const seen = visited ?? new Set<string>();
  const currentDepth = depth ?? 0;

  // Cycle detection
  const key = uri;
  if (seen.has(key)) return null;
  seen.add(key);

  // Depth limit
  if (currentDepth > MAX_DEPTH) return null;

  // ... existing one-hop code ...

  // NEW: for each inherit target, recurse into ITS inherits
  for (const decl of table.declarations) {
    if (decl.kind === "inherit" || decl.kind === "import") {
      const target = await resolveInheritTarget(ctx, decl, uri);
      if (target) {
        const targetEntry = getFile(ctx, target.uri);
        if (targetEntry?.symbolTable) {
          // Check target's declarations
          for (const targetDecl of targetEntry.symbolTable.declarations) {
            if (targetDecl.name === ref.name) {
              return { uri: target.uri, decl: targetDecl };
            }
          }
          // RECURSE: check target's inherited symbols
          const inherited = await resolveUnresolvedReference(
            ctx, ref, targetEntry.symbolTable, target.uri, seen, currentDepth + 1,
          );
          if (inherited) return inherited;
        }
      }
    }
  }

  // ... rest of existing code (directory module) ...
}
```

**Step 3: Add test corpus files for 3-level cross-file inherit**

Create corpus files:
- `corpus/files/grandparent.pike` — class `Animal` with method `breathe()`
- `corpus/files/parent-inherits-grandparent.pike` — class `Dog` inherits `Animal`
- `corpus/files/child-inherits-parent.pike` — class `Puppy` inherits `Dog`, references `breathe`

**Step 4: Add adversarial test for circular inheritance**

Create a test case where A inherits B and B inherits A (or the files form a cycle via imports). Verify it terminates without stack overflow.

**Step 5: Run tests**

```bash
bun test tests/lsp/
```

**Step 6: Commit**

```bash
git add server/src/features/workspaceResolution.ts tests/lsp/
git commit -m "fix(resolution): transitive inherit resolution with cycle detection"
```

---

## Task 4: Complex initializer type inference (L3)

**Objective:** Extend `extractInitializerType` to handle member access chains and index expressions.

**Files:**
- Modify: `server/src/features/scope-helpers.ts` (`extractInitializerExprType`)
- Modify: `tests/lsp/typeResolution.test.ts`

**Step 1: Read the current extraction pipeline**

Read `scope-helpers.ts` lines 219-350 to understand the full extraction chain:
`extractInitializerType` → `extractInitializerExprType` → `drillForIdentifier`

**Step 2: Extend `extractInitializerExprType` for member access**

When the value node is a `postfix_expr` with children:
- `identifier . identifier` → this is a member access like `Constants.Dog`. We can't resolve the type statically. Return undefined.
- `identifier ( args )` → constructor call like `Dog()`. Currently handled.
- `identifier . identifier ( args )` → static method call like `Factory.create()`. We could extract the return type if we resolve, but for now return undefined (avoid overreach).

The key insight: the current code already handles `postfix_expr` by drilling to `child(0)`. What's missing:
1. **Assignment from existing variable**: `Dog d1 = Dog("Rex"); Dog d2 = d1;` — `d2` should infer type `Dog` from `d1`'s assignedType. This requires symbol table lookup, which is not available in the extraction phase.

**Approach**: Keep the extraction phase pure (no symbol table). Instead, add a *post-extraction resolution* pass in the scope builder that:
1. After all declarations are collected, walks variables with no `assignedType`
2. If the initializer is a bare identifier, looks up the identifier's `assignedType` from the symbol table
3. Propagates: `Dog d1 = Dog("Rex"); Dog d2 = d1;` → d1 gets `Dog` at extraction, d2 gets `Dog` at propagation

**Step 3: Implement `propagateAssignedTypes` in `scopeBuilder.ts`**

```typescript
function propagateAssignedTypes(table: SymbolTable): void {
  // Build a map of variable name → assignedType for all declarations in scope
  const varTypes = new Map<string, string>();
  for (const decl of table.declarations) {
    if (decl.assignedType) {
      varTypes.set(decl.name, decl.assignedType);
    }
  }

  // Walk declarations with no assignedType whose initializer is a bare identifier
  for (const decl of table.declarations) {
    if (decl.assignedType) continue;
    if (decl.kind !== "variable" && decl.kind !== "local") continue;
    // Check if the source node's value is a bare identifier
    // If so, look up the identifier in varTypes
    // If found, set decl.assignedType = varTypes.get(identifier)
  }
}
```

Call `propagateAssignedTypes(table)` at the end of `buildSymbolTable()`.

**Step 4: Add tests**

Test cases:
1. `Dog d1 = Dog("Rex"); Dog d2 = d1;` → d2.assignedType === "Dog"
2. `Dog d1 = Dog("Rex"); mixed d2 = d1;` → d2.assignedType === "Dog"
3. `mixed x = unknown_var;` → no assignedType (unresolved)
4. Chain: `Dog d1 = Dog(); Dog d2 = d1; Dog d3 = d2;` → d3.assignedType === "Dog"
5. Adversarial: self-reference `mixed x = x;` → no assignedType (cycle)

**Step 5: Run tests**

```bash
bun test tests/lsp/typeResolution.test.ts
```

**Step 6: Commit**

```bash
git add server/src/features/scope-helpers.ts server/src/features/scopeBuilder.ts tests/lsp/typeResolution.test.ts
git commit -m "feat(type-inference): propagate assignedType through variable aliases"
```

---

## Task 5: Type-aware cross-file rename filtering (L4)

**Objective:** Filter cross-file rename candidates by resolved type, not just name.

**Files:**
- Modify: `server/src/features/workspaceResolution.ts:98-156` (`getCrossFileReferences`)
- Modify: `server/src/features/rename.ts:244-272` (where cross-file refs are consumed)
- Modify: `tests/lsp/rename.test.ts`

**Step 1: Read the current cross-file matching**

The current `getCrossFileReferences` at line 149 matches `ref.name === target.name && ref.resolvesTo === null`. This is name-only.

The rename consumer at `rename.ts:256-263` already does type-aware filtering for arrow/dot access. The gap is for bare identifier refs (e.g., `speak()` without a `d->` prefix) in cross-file scope.

**Step 2: Add scope-aware filtering**

The approach: when a cross-file reference `ref` is found by name, check if the reference's enclosing scope is a class scope. If it is, check if that class is the same class (or inherits from) the target's declaring class. This requires:
1. For the target declaration, identify its declaring class (if any)
2. For the cross-file reference, identify its enclosing class scope
3. If both are class-scoped, verify the classes are compatible (same name or inherit chain)

This is a *scope-based* heuristic, not full type resolution. It's much cheaper and covers the common case.

```typescript
// In getCrossFileReferences, after the name match:
if (ref.name === target.name && ref.resolvesTo === null) {
  // Scope-aware filter: if the target is a class member, check that
  // the reference's enclosing class has the same name.
  if (target.kind === "method" || target.kind === "field") {
    const targetClass = findEnclosingClass(table, target);
    const refClass = findEnclosingClassInDependent(depEntry.symbolTable, ref);
    if (targetClass && refClass && targetClass !== refClass) {
      // Different classes — skip this match
      continue;
    }
  }
  results.push({ uri: depUri, ref });
}
```

**Step 3: Add adversarial tests**

1. Two files, each with a class that has a method `speak()`. Renaming `Dog.speak` should NOT rename `Cat.speak` in the other file.
2. Two files with same-name free functions (not class-scoped). These SHOULD both be renamed (same name, same scope level).
3. Child class inherits parent's method, overrides it. Renaming parent's method should rename child's cross-file references too.

**Step 4: Run tests**

```bash
bun test tests/lsp/rename.test.ts
```

**Step 5: Commit**

```bash
git add server/src/features/workspaceResolution.ts server/src/features/rename.ts tests/lsp/rename.test.ts
git commit -m "fix(rename): scope-aware cross-file reference filtering"
```

---

## Task 6: Message-based diagnostic column precision (L5)

**Objective:** Use Pike error message text to locate the exact error token in the tree-sitter parse.

**Files:**
- Modify: `server/src/features/diagnosticUtils.ts` (`lineToColumn` and `pikeDiagnosticToLsp`)
- Modify: `tests/lsp/diagnostics.test.ts`

**Step 1: Analyze Pike error message patterns**

From verification, Pike error messages follow these patterns:
- `"Bad type in assignment."` + `"Expected: TYPE."` + `"Got     : TYPE."`
- `"Undefined identifier NAME."`
- `"Too few arguments to NAME (got N)."`
- `"Too many arguments to NAME (got N)."`
- `"Unknown program TYPE."`
- `"Cannot index TYPE."`
- `"Illegal CAST."`
- `"Calling a void expression."`

The key patterns that contain a name we can locate:
- `"Undefined identifier X."` → locate identifier `X` on the line
- `"Too few arguments to X"` → locate identifier `X` on the line
- `"Too many arguments to X"` → locate identifier `X` on the line
- `"Bad type in assignment."` → locate the assignment operator `=` on the line, then underline the RHS
- `"Cannot index TYPE."` → locate the index expression `[` on the line

**Step 2: Implement `messageAwareColumn`**

Add a new function in `diagnosticUtils.ts`:

```typescript
/**
 * Attempt to locate the precise column of the error token using the
 * Pike error message text. Falls back to lineToColumn (first-token heuristic)
 * when the message pattern is not recognized.
 *
 * Pike's compile_error provides (file, line, message) — no column.
 * But the message text often contains the identifier or keyword that
 * caused the error. We extract that text and find it in the tree-sitter
 * parse tree for the diagnostic's line.
 */
function messageAwareColumn(
  tree: Tree,
  line: number,
  message: string,
  lines?: string[],
): number {
  // Try to extract a name from the error message
  const name = extractErrorName(message);
  if (name) {
    // Search for this identifier on the line in the tree
    const col = findIdentifierOnLine(tree, line, name);
    if (col >= 0) return col;
  }

  // Assignment errors: locate the = sign
  if (message.includes("Bad type in assignment")) {
    const col = findTokenOnLine(tree, line, ["=", "assign_expr"]);
    if (col >= 0) return col;
  }

  // Fallback: first meaningful token
  return lineToColumn(tree, line, lines);
}

function extractErrorName(message: string): string | null {
  // "Undefined identifier X."
  let m = message.match(/^Undefined identifier (\w+)\.$/);
  if (m) return m[1];
  // "Too few arguments to X (got N)."
  m = message.match(/^Too (?:few|many) arguments to (\w+)/);
  if (m) return m[1];
  // "Unknown program X."
  m = message.match(/^Unknown program (\w+)\.$/);
  if (m) return m[1];
  // "Cannot index X."
  m = message.match(/^Cannot index (\w+)\.$/);
  if (m) return m[1];
  return null;
}
```

**Step 3: Integrate into `pikeDiagnosticToLsp`**

In the existing `pikeDiagnosticToLsp` function (which calls `lineToColumn`), replace:
```typescript
const character = tree ? lineToColumn(tree, pd.line, lines) : 0;
```
with:
```typescript
const character = tree ? messageAwareColumn(tree, pd.line, pd.message, lines) : 0;
```

**Step 4: Add tests**

Test cases:
1. `"Undefined identifier x."` on line `int result = calculate(x);` → column points to `x`
2. `"Too few arguments to greet (got 1)."` on line `greet("hello");` → column points to `greet`
3. `"Bad type in assignment."` on line `int x = "hello";` → column points to `=` or `"hello"`
4. Unknown message pattern → falls back to first-token heuristic
5. Empty line → returns 0

**Step 5: Run tests**

```bash
bun test tests/lsp/diagnostics.test.ts
```

**Step 6: Commit**

```bash
git add server/src/features/diagnosticUtils.ts tests/lsp/diagnostics.test.ts
git commit -m "feat(diagnostics): message-aware column precision for Pike errors"
```

---

## Task 7: Clean up integration test skip (L6)

**Objective:** File tracking issue for the output channel test, convert to documented manual smoke test.

**Files:**
- Modify: `tests/integration/suite/index.ts:186-206`
- Create: `MANUAL_SMOKE_TESTS.md` (if not exists)

**Step 1: File a GitHub issue**

```bash
gh issue create --repo TheSmuks/pike-language-server \
  --title "Automated output channel verification" \
  --body "The output channel duplicate suppression fix (extension.ts passes outputChannel to LanguageClient) currently has an \`it.skip\` test. The VSCode extension host API does not expose output channel listing for automated verification. Convert to a manual smoke test entry or find an extension host API for inspection."
```

**Step 2: Update the skip with the issue link**

Replace the TODO in `tests/integration/suite/index.ts:193-194`:
```typescript
// TODO: Create a tracking issue for automated output channel verification.
//   See: https://github.com/TheSmuks/pike-language-server/issues/XXX
```
with:
```typescript
// SKIP: no extension host API for output channel listing.
// Tracked: https://github.com/TheSmuks/pike-language-server/issues/<NUMBER>
```

**Step 3: Run integration tests to verify skip still passes**

```bash
bun test tests/integration/suite/index.ts
```

**Step 4: Commit**

```bash
git add tests/integration/suite/index.ts
git commit -m "chore(test): track output channel skip with GitHub issue"
```

---

## Task 8: Update known-limitations.md

**Objective:** Mark resolved limitations and update descriptions.

**Files:**
- Modify: `docs/known-limitations.md`

**Step 1: Update each resolved limitation**

For L1 (call hierarchy): Move the existing limitation entry to Resolved section.
For L2 (transitive inherit): Update description — remove "one-hop only" qualifier.
For L3 (initializer inference): Update description — note variable alias propagation.
For L4 (cross-file matching): Update description — note scope-aware filtering.
For L5 (diagnostic columns): Update description — note message-based precision.
For L6 (integration test): Already documented; update the skip note with issue link.

**Step 2: Commit**

```bash
git add docs/known-limitations.md
git commit -m "docs: update known-limitations for resolved items"
```

---

## Task 9: Update CHANGELOG.md and architecture docs

**Files:**
- Modify: `CHANGELOG.md` (add entries under `[Unreleased]`)
- Modify: `docs/architecture.md` (if component structure changed)

**Step 1: Add changelog entries**

Under `## [Unreleased]`:

```markdown
### Fixed

  - Call hierarchy outgoing calls: `collectCallExpressions` now searches for
    `postfix_expr` with `argument_list` instead of non-existent `call_expression`
    nodes. Outgoing calls now resolve correctly.
  - Transitive inherit resolution: cross-file reference resolution now follows
    inherit chains beyond one hop (max depth 10, with cycle detection).
  - Type inference through variable aliases: `mixed d2 = d1` where `d1` has
    `assignedType = "Dog"` now propagates `Dog` to `d2` for member completion.
  - Cross-file rename: scope-aware filtering prevents renaming same-name methods
    in unrelated classes across files.
  - Diagnostic column precision: Pike error messages are now parsed for identifier
    names ("Undefined identifier X", "Too few arguments to Y") to locate the exact
    error token instead of defaulting to the first token on the line.

### Changed

  - `lineToColumn()` in `diagnosticUtils.ts` now delegates to `messageAwareColumn()`
    which extracts token names from Pike error messages for precise positioning.
```

**Step 2: Validate changelog**

```bash
node scripts/validate-changelog.js CHANGELOG.md
```

**Step 3: Commit**

```bash
git add CHANGELOG.md docs/
git commit -m "docs: changelog and architecture updates for limitations sprint"
```

---

## Task 10: Full test suite and pre-flight

**Objective:** Verify everything works together.

**Step 1: Run full test suite**

```bash
bun test
```

**Step 2: Run typecheck**

```bash
bun run typecheck
```

**Step 3: Run build**

```bash
bun run build
```

**Step 4: Fix any failures**

Address any test failures or type errors before proceeding to release.

---

## Task 11: Cut patch release

Follow `pike-cut-release` skill.

1. Determine version (patch bump from current)
2. Run pre-flight checks
3. Execute release script
4. Create PR, merge, tag, publish

---

## Dependency Graph

```
L1 (call hierarchy) ── independent
L2 (transitive inherit) ── independent
L3 (type inference) ── independent
L4 (cross-file rename) ── independent (but L2 helps)
L5 (diagnostic columns) ── independent
L6 (integration test) ── independent
Task 8 (docs) ── depends on L1-L6
Task 9 (changelog) ── depends on L1-L6
Task 10 (preflight) ── depends on all above
Task 11 (release) ── depends on Task 10
```

All L1-L6 can be implemented in parallel or sequentially. Tasks 8-11 are sequential and depend on all L-tasks completing.
