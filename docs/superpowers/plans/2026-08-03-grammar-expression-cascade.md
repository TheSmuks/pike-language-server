# Grammar Expression-Cascade Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Determine, with one decisive experiment, whether collapsing tree-sitter-pike's expression unit-production spine makes the parser insert `MISSING ";"` instead of opening an ERROR node — and only then decide whether to pay for the migration.

**Architecture:** This plan is **gate-first**. Task 1 is a throwaway spike that answers a single yes/no question. Everything after it is one of two mutually exclusive branches, and Task 1's result picks the branch. The rewrite is not assumed to work: the obvious version of it has already been tried and **demonstrably does not**, so committing to the migration before the gate passes would be building on a disproven premise.

**Tech Stack:** tree-sitter CLI 0.26.8, `grammar.ts` (bundled to `grammar.js` by `bun build`), an external scanner in C (`src/scanner.c`), bun test, the Roxen corpus at `/tank/projects/roxen-6.1`.

---

## Background: what is already known

Do not re-derive any of this. Each line was established by experiment, and the
dead ends cost real time.

### The symptom

A statement whose expression ends in an **operand** and is missing its `;`
recovers as an ERROR node instead of an inserted `MISSING ";"`:

```
int main() { f()       \n return 0; }   ->  clean (tree-sitter inserts MISSING ";")
int main() { int x     \n return 0; }   ->  MISSING ";"
int main() { int x = 1 \n return 0; }   ->  ERROR
int main() { x = 1     \n return 0; }   ->  ERROR
int main() { x + 1     \n return 0; }   ->  ERROR
```

### What the bad tree actually looks like

For `int x = 1` followed by `return 0;`, the declaration **absorbs the next
statement**:

```
local_declaration [1,2]-[2,11]
  type: int
  name: x
  (ERROR [1,10]-[2,8] (identifier "return"))     <- holds `1` and `return`
  value: comma_expr [2,9]-[2,10]                 <- the `0` from `return 0;`
```

### Four disproven theories

| theory | verdict |
|---|---|
| It is the caret / position query | **No.** On source with zero ERROR nodes, `descendantForPosition` at the end boundary of `name` answers `;`. That is what a point query means; no grammar changes it. |
| It is the decl-vs-expr ambiguity | **No.** `x = 1` with no type at all fails identically. |
| It is the depth of the binary-operator cascade | **No.** All ten binary levels were flattened to `prec.left(N, seq($._binop_operand, op, $._binop_operand))`. Generated with **zero conflicts**, correctly removed ten unit productions (`cond_expr -> unary_expr` directly), precedence still correct — and recovery was **byte-for-byte unchanged**. |
| It is where/how `;` is written | **No.** Extracting a shared hidden `_terminator: $ => ';'`, and separately factoring the whole `expr ;` tail into a shared production, both generate cleanly and are both **inert**. |

### The mechanism, as far as it is pinned

tree-sitter only manufactures a MISSING token when the error state's action for
that token is a **SHIFT**. In every failing case the action for `;` is a
**REDUCE** — the parser fails while the last operand is still unreduced on the
stack. `int x` works only because `local_declaration -> type identifier ';'`
gives its state a literal SHIFT on `;`.

A competing model — "there is a budget of ~9 unit reductions between the operand
state and the first `;`-shiftable state, and Pike's is 17" — was also produced.
**Its proposed test is invalid:** it relies on counting `recover_with_missing`
in `tree-sitter parse --debug` output, and that string appears **zero** times in
CLI 0.26.8 even for `int x`, which demonstrably *does* emit `MISSING ";"`. Do
not use that metric. If you need to distinguish the two models, instrument the
parser directly (see Task 1, Step 4).

### Measured real-world impact — read this before spending effort

This is why the plan is gate-first rather than a straight rewrite.

- On **well-formed** code the ERROR nodes barely exist: 2 of 93 Roxen files, 5 of
  87 corpus files carry any ERROR/MISSING node at rest.
- The symbol table already survives the bad tree. For the case above,
  `x` still gets `declaredType: "int"`, no wrong `assignedType`, and no phantom
  references. **The only damage is `decl.range` inflated by one line**, and only
  while the statement is unfinished.
- `collectDeclarations` already descends into ERROR nodes deliberately
  (`declarationCollector.ts`), with a comment recording that not doing so "used
  to blank every semantic token in the file on almost every keystroke."

So the payoff is bounded to a transiently inflated range mid-keystroke. The cost
is in the next section. Weigh them honestly at the gate.

---

## Global Constraints

- **Never modify `/tank/projects/tree-sitter-pike` outside a dedicated branch.**
  It is currently clean at commit `4d1528b`. Spikes happen in a copy under
  `/tmp/.../scratchpad/`, never in the repo.
- **The grammar's own suite does not gate this work.** It passed 258/258
  unchanged under both dead-end variants above and would not have caught a
  regression. The Roxen corpus is the gate — see `tools/lsp-audit/wrong-target-sweep.ts`
  and `symbol-integrity-sweep.ts` in the language-server repo.
- **Expression node names are consumed in 179 places across 14 files** in
  `server/src/` and `queries/`. `comma_expr`, `assign_expr`, `postfix_expr`,
  `primary_expr` are load-bearing: `signatureHelp.ts` descends `comma_expr` to
  count argument separators, and the highlight queries name several.
- Grammar build: `bun run generate` (bundles `grammar.ts` -> `grammar.js`, then
  `tree-sitter generate`). WASM for the server: `bash scripts/build-wasm.sh`,
  then copy into `server/` and regenerate goldens. There is no in-repo golden
  regeneration script.
- Any grammar change requires a full Roxen sweep **and** a corpus parse-rate
  check; the current architectural ceiling is 1071/1082 files (99.0%) and must
  not regress.

---

## File Structure

Task 1 touches nothing permanent. The branches differ entirely:

**Branch A (gate fails — expected):**
- Modify: `docs/known-limitations.md` *(grammar repo)* — record the mechanism and
  the four dead ends so nobody re-derives them.
- Optionally modify: `server/src/features/declarationCollector.ts` — clamp an
  absorbed declaration's range. One file, one behaviour.

**Branch B (gate passes):**
- Modify: `grammar.ts` *(grammar repo)* — collapse the spine.
- Regenerate: `src/parser.c`, `src/grammar.json`, `src/node-types.json`, `tree-sitter-pike.wasm`.
- Modify: `queries/*.scm` *(both repos)* — renamed node types.
- Modify: 14 files under `server/src/` — renamed node types.
- Regenerate: all 258 corpus goldens.

---

### Task 1: The gate — does collapsing the whole spine fix recovery?

**Files:**
- Create: `/tmp/claude-1000/.../scratchpad/gate/` (throwaway copy of the grammar)
- Modify: nothing permanent

**Interfaces:**
- Consumes: nothing
- Produces: a yes/no answer that selects Branch A or Branch B. Nothing else.

The binary-operator flattening removed ten unit productions and changed nothing.
What remains between an operand and a `;`-shiftable state is the spine:
`identifier_expr`/`primary_expr` -> `postfix_expr` -> `unary_expr` ->
`cond_expr` -> `assign_expr` -> `comma_expr` -> `_expr`. This task collapses
**that** and measures. It is a spike: the code is thrown away either way.

- [ ] **Step 1: Make a throwaway copy of the grammar**

```bash
S=/tmp/claude-1000/-tank-projects-pike-language-server/438f488f-3867-484c-acd3-62f99244921a/scratchpad
rm -rf "$S/gate" && cp -r /tank/projects/tree-sitter-pike "$S/gate"
cd "$S/gate" && git status --short   # expect: empty
```

- [ ] **Step 2: Record the baseline**

```bash
cd "$S/gate"
printf 'int main() {\n  x = 1\n  return 0;\n}\n'      > /tmp/g1.pike
printf 'int main() {\n  int x = 1\n  return 0;\n}\n'  > /tmp/g2.pike
for f in g1 g2; do bunx tree-sitter parse --quiet /tmp/$f.pike; done
```

Expected: both report `(ERROR ...)`.

- [ ] **Step 3: Collapse the spine into one flat expression rule**

In `$S/gate/grammar.ts`, replace the chain `primary_expr` / `postfix_expr` /
`unary_expr` / `cond_expr` / `assign_expr` / `comma_expr` with a single
precedence-annotated rule. Keep the binary flattening from the known-good
variant. The shape:

```js
    // One nonterminal, precedence by level — no unit productions between an
    // operand and the expression root.
    _expr: $ => $.expression,

    expression: $ => choice(
      $.identifier,
      $.integer_literal,
      $.string_literal,
      prec.left(1,  seq($.expression, ',',  $.expression)),
      prec.right(2, seq($.expression, '=',  $.expression)),
      prec.right(3, seq($.expression, '?',  $.expression, ':', $.expression)),
      prec.left(4,  seq($.expression, '||', $.expression)),
      prec.left(5,  seq($.expression, '&&', $.expression)),
      prec.left(10, seq($.expression, choice('+', '-'), $.expression)),
      prec.left(11, seq($.expression, choice('*', '/', '%'), $.expression)),
      prec(20, seq($.expression, '(', optional($.expression), ')')),
      prec(20, seq($.expression, '->', $.identifier)),
    ),
```

This is a **spike, not the deliverable**. It does not need to cover every Pike
operator — it needs to cover enough that `x = 1` and `int x = 1` parse, so that
the recovery question can be answered. Delete or stub whatever else fails to
generate; correctness of the wider grammar is not being tested here.

- [ ] **Step 4: Generate and measure**

```bash
cd "$S/gate" && bun run generate 2>&1 | tail -5
for f in g1 g2; do bunx tree-sitter parse --quiet /tmp/$f.pike; done
```

**This is the gate.** Pass = both cases report `MISSING ";"` or `clean`.
Fail = either still reports `(ERROR ...)`.

If it generates with conflicts, resolve them *only* far enough to answer the
question; do not invest in a conflict-free spike.

If you want to distinguish the two competing models rather than just get the
yes/no, instrument directly instead of trusting `--debug` output:

```c
/* Link against the generated parser and the tree-sitter runtime, then for the
   state on top of the stack at the failure point, print
   ts_language_next_state(lang, state, ts_builtin_sym_end) and the action for
   ';'. SHIFT means insertion is possible; REDUCE means it is not. */
```

- [ ] **Step 5: Record the answer and stop**

Write the result — the exact parse output for both cases — into the plan file
under a new "Gate result" heading, and commit that.

```bash
cd /tank/projects/pike-language-server
git add docs/superpowers/plans/2026-08-03-grammar-expression-cascade.md
git commit -m "docs: record the expression-cascade gate result"
```

Then **stop and choose a branch.** Do not start Branch B on a failed gate.

- [ ] **Step 6: Delete the spike**

```bash
rm -rf "$S/gate"
```

---

---

## Gate result — FAILED (2026-08-03)

Task 1 was run. **Collapsing the expression spine does not change recovery.**

The decisive evidence is a controlled A/B in a minimal standalone grammar where
the spine shape was the *only* variable — one with Pike's unit-production
cascade, one with a single flat `expression` rule and precedence by level:

| input | cascade | flat |
|---|---|---|
| `int x = 1` + `return 0;` | `MISSING ";"` | `MISSING ";"` |
| `x = 1` + `return 0;` | `ERROR` | `ERROR` |
| `int x` + `return 0;` | `MISSING ";"` | `MISSING ";"` |
| `f()` + `return 0;` | `ERROR` | `ERROR` |
| `int x = 1;` + `return 0;` | clean | clean |

**Identical on every input.** Combined with the earlier real-Pike experiment
(ten binary levels flattened, recovery unchanged), the direction is disproven
twice, in two independent settings.

Two further facts, so nobody re-treads them:

- Adding Pike's `commaSep1` declarator list to the minimal grammar — which
  needs a GLR `conflicts` entry for `_expr`/`comma_expr`, exactly as the real
  grammar has — still recovers. The declarator list is not the cause either.
- In the real grammar, neither `_class_value` in the initializer choice nor
  `preproc_conditional_expr` in `_expr` is the cause; removing each in turn
  leaves the ERROR unchanged.

So the minimal grammar cannot reproduce Pike's `int x = 1` failure at all,
under any spine shape. Whatever is specific to Pike remains unidentified — and
it does not matter, because the generic case (`x = 1`, no type) IS reproduced
and is unaffected by the collapse.

**Branch taken: A.** Branch B is off. The downstream fix shipped instead —
`server/src/features/absorbedStatements.ts` re-parses the absorbed text and
merges the declarations it yields, which fixes the actual user-visible defect
(a declaration on the following line vanishing from the symbol table) rather
than the range symptom alone. Task A2 as written is therefore superseded: it
proposed clamping the range only, which would have left `y` lost.


## Branch A — the gate failed (expected outcome)

Take this branch if Task 1 Step 4 still reported `(ERROR ...)`. It means no
realistic grammar shape makes `;` shiftable at the point of failure, and the
rewrite is off.

### Task A1: Record the finding in the grammar repo

**Files:**
- Modify: `/tank/projects/tree-sitter-pike/docs/known-limitations.md`

**Interfaces:**
- Consumes: the gate result from Task 1
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Add the section**

Append to `docs/known-limitations.md`:

```markdown
## Missing-semicolon recovery opens an ERROR node

A statement whose expression ends in an operand and is missing its `;` recovers
as an ERROR node rather than an inserted `MISSING ";"`, and the enclosing
declaration absorbs the following statement.

    int main() { f()       \n return 0; }  ->  clean
    int main() { int x     \n return 0; }  ->  MISSING ";"
    int main() { int x = 1 \n return 0; }  ->  ERROR
    int main() { x = 1     \n return 0; }  ->  ERROR

tree-sitter only manufactures a MISSING token when the error state's action for
that token is a SHIFT. Here it is a REDUCE, because the parser fails while the
last operand is still unreduced. `int x` works only because
`local_declaration -> type identifier ';'` gives that state a literal SHIFT.

Disproven, do not retry: flattening the ten binary-operator levels into
`prec.left(N, seq($._binop_operand, op, $._binop_operand))` (generates clean,
removes ten unit productions, recovery unchanged); extracting a shared hidden
`_terminator: $ => ';'`; factoring the `expr ;` tail into a shared production;
changing `extras`, `conflicts`, `inline` or `supertypes`. Collapsing the whole
expression spine was tested at <date> and also failed — see
pike-language-server `docs/superpowers/plans/2026-08-03-grammar-expression-cascade.md`.

Note `tree-sitter parse --debug` does not print `recover_with_missing` in CLI
0.26.8, even for cases that do insert one. Do not use it as a metric.
```

- [ ] **Step 2: Commit**

```bash
cd /tank/projects/tree-sitter-pike
git add docs/known-limitations.md
git commit -m "docs: record why missing-semicolon recovery opens an ERROR node"
```

### Task A2: Stop the absorbed statement inflating a declaration's range

**Files:**
- Modify: `server/src/features/declarationCollector.ts`
- Test: `tests/lsp/incompleteStatementRange.test.ts`

**Interfaces:**
- Consumes: nothing from Task A1
- Produces: nothing consumed by later tasks

Only do this task if the inflated range is actually costing something. It is the
*whole* measured impact, and it is transient. Before starting, confirm it
matters — e.g. an inlay hint or code lens landing on the wrong line mid-typing.
If you cannot demonstrate a user-visible consequence, **skip this task** and
close the plan at A1.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeAll } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";

describe("an unfinished statement does not inflate the declaration's range", () => {
  beforeAll(async () => { await initParser(); });

  test("the range stops at the declaration's own line", () => {
    // No `;` — what the buffer looks like mid-keystroke. The grammar makes the
    // local_declaration absorb `return 0;`, so its range covers two lines.
    const src = `int main() {\n  int x = 1\n  return 0;\n}\n`;
    const table = buildSymbolTable(parse(src)!, "file:///a.pike", 1, undefined, src);
    const x = table.declarations.find(d => d.name === "x");
    expect(x).toBeDefined();
    expect(x!.range.start.line).toBe(1);
    expect(x!.range.end.line).toBe(1);
  });

  test("a complete declaration is unaffected", () => {
    const src = `int main() {\n  int x = 1;\n  return 0;\n}\n`;
    const table = buildSymbolTable(parse(src)!, "file:///a.pike", 1, undefined, src);
    const x = table.declarations.find(d => d.name === "x")!;
    expect(x.range.start.line).toBe(1);
    expect(x.range.end.line).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
bun test tests/lsp/incompleteStatementRange.test.ts
```

Expected: the first test fails with `expected 1, received 2`.

- [ ] **Step 3: Clamp the range when an ERROR child absorbed the next statement**

In `collectSimpleDecl` (`declarationBlockCollectors.ts`), where `range: toRange(decl)`
is built, clamp the end to the last non-ERROR child:

```typescript
/**
 * A declaration's range, stopping before any statement it absorbed.
 *
 * When a statement is missing its `;`, tree-sitter opens an ERROR node rather
 * than inserting one, and the declaration swallows the following statement —
 * `int x = 1` with `return 0;` under it produces a local_declaration spanning
 * both lines. Reporting that range puts inlay hints and code lenses a line
 * away from what they annotate, every keystroke until the `;` is typed.
 */
function declRangeWithoutAbsorbed(decl: Node): Range {
  const full = toRange(decl);
  const firstError = decl.children.find(c => c.isError);
  if (!firstError) return full;
  return {
    start: full.start,
    end: {
      line: firstError.startPosition.row,
      character: firstError.startPosition.column,
    },
  };
}
```

- [ ] **Step 4: Run the test and the suite**

```bash
bun test tests/lsp/incompleteStatementRange.test.ts
bun test
```

Expected: new tests pass; 2731+ pass, 0 fail.

- [ ] **Step 5: Verify nothing regressed on real code**

```bash
bun run tools/lsp-audit/wrong-target-sweep.ts --root /tank/projects/roxen-6.1/server/etc
bun run tools/lsp-audit/symbol-integrity-sweep.ts --root /tank/projects/roxen-6.1/server/etc
```

Expected: `wrong` 255 (all `this`/`this_object()`), `wrong-column` 0, integrity 0 findings.

- [ ] **Step 6: Commit**

```bash
git add server/src/features/declarationBlockCollectors.ts tests/lsp/incompleteStatementRange.test.ts
git commit -m "fix(symbols): stop an unfinished statement inflating a declaration's range"
```

---

## Branch B — the gate passed

Take this branch **only** if Task 1 Step 4 reported `MISSING ";"` or `clean` for
both cases. Every task here is expensive and irreversible-ish; the gate is what
justifies them.

Before starting, re-read the impact measurement in the Background section. A
passing gate proves the fix is *possible*, not that it is *worth it*. If the
only benefit remains a transiently inflated range, prefer Branch A regardless.

### Task B1: Collapse the spine in the real grammar

**Files:**
- Modify: `/tank/projects/tree-sitter-pike/grammar.ts`
- Regenerate: `src/parser.c`, `src/grammar.json`, `src/node-types.json`

**Interfaces:**
- Consumes: the spike's rule shape from Task 1 Step 3
- Produces: a grammar whose expression nodes are named per the decision below

- [ ] **Step 1: Decide and write down the node naming**

The spike used a single `expression` node. That deletes `comma_expr`,
`assign_expr`, `cond_expr`, `unary_expr`, `postfix_expr`, `primary_expr` from
every tree. Two options — pick one and record it in the plan before writing code:

- **(a) Single `expression` node.** Smallest grammar, largest migration:
  every one of the 179 consumer references must be rewritten to discriminate on
  the operator child instead of the node type.
- **(b) Keep per-level rule names, drop only the unit productions** — e.g.
  `assign_expr: $ => prec.right(2, seq($._expr, '=', $._expr))`. Node names
  survive, so most consumers keep working. **Try this first**: the gate spike
  used (a) for speed, but if (b) also passes the gate it is dramatically cheaper.

- [ ] **Step 2: Re-run the gate against the chosen shape**

```bash
cd /tank/projects/tree-sitter-pike   # on a branch, not main
git checkout -b fix/expression-spine
# apply the chosen shape to grammar.ts
bun run generate 2>&1 | tail -5
printf 'int main() {\n  x = 1\n  return 0;\n}\n' > /tmp/g1.pike
bunx tree-sitter parse --quiet /tmp/g1.pike
```

Expected: `MISSING ";"` or clean, and generation without conflicts.
If shape (b) fails the gate, fall back to (a) and accept the larger migration.

- [ ] **Step 3: Check the corpus parse rate has not regressed**

```bash
bun run test        # the grammar's own 258 cases
```

Expected: 258/258. **This is necessary but not sufficient** — it passed under
both dead-end variants. The real check is Task B3.

- [ ] **Step 4: Commit the grammar change**

```bash
git add grammar.ts grammar.js src/
git commit -m "fix: collapse the expression unit-production spine"
```

### Task B2: Rebuild the WASM and wire it into the server

**Files:**
- Regenerate: `/tank/projects/tree-sitter-pike/tree-sitter-pike.wasm`
- Modify: `server/tree-sitter-pike.wasm` (copied in)

**Interfaces:**
- Consumes: the generated parser from Task B1
- Produces: a server that parses with the new grammar

- [ ] **Step 1: Build the WASM**

```bash
cd /tank/projects/tree-sitter-pike && bash scripts/build-wasm.sh
```

- [ ] **Step 2: Copy it into the server and check what breaks**

```bash
cd /tank/projects/pike-language-server
cp /tank/projects/tree-sitter-pike/tree-sitter-pike.wasm server/
bun test 2>&1 | tail -20
```

Expect failures — that is the point of this step. Record the list; it is the
migration's worklist for Task B3.

- [ ] **Step 3: Commit the wasm alone, so the migration diff stays readable**

```bash
git add server/tree-sitter-pike.wasm
git commit -m "chore: rebuild the grammar wasm with the collapsed expression spine"
```

### Task B3: Migrate the consumers

**Files:**
- Modify: the 14 files under `server/src/` naming expression nodes
- Modify: `queries/*.scm` in both repos

**Interfaces:**
- Consumes: the failure list from Task B2 Step 2
- Produces: a green suite on the new grammar

- [ ] **Step 1: Enumerate every consumer**

```bash
grep -rn "comma_expr\|lor_expr\|land_expr\|postfix_expr\|assign_expr\|primary_expr\|cond_expr\|unary_expr" \
  server/src/ queries/ | tee /tmp/consumers.txt
wc -l /tmp/consumers.txt
```

- [ ] **Step 2: Migrate the load-bearing one first, with its test**

`signatureHelp.ts`'s `countCommasInNode` descends **only** through `comma_expr`
to distinguish argument separators from commas inside arguments. If `comma_expr`
is gone, it must discriminate on the operator instead. Its test
(`tests/lsp/signatureHelpGaps.test.ts`, "commas inside an argument are not
argument separators") is the guard — run it after every edit.

```bash
bun test tests/lsp/signatureHelpGaps.test.ts
```

- [ ] **Step 3: Work down the list, running the suite after each file**

```bash
bun test 2>&1 | tail -5
```

- [ ] **Step 4: Regenerate the goldens**

There is no in-repo script. Regenerate per `AGENTS.md`, then **read the diff** —
every expression tree changes shape, so a wrong change hides easily in the noise.
Spot-check at least five goldens by hand against the source.

- [ ] **Step 5: Commit**

```bash
git add server/src/ queries/ tests/
git commit -m "refactor: migrate consumers to the collapsed expression nodes"
```

### Task B4: Validate against real code

**Files:** none modified

**Interfaces:**
- Consumes: the migrated server from Task B3
- Produces: the evidence that decides whether this ships

- [ ] **Step 1: Corpus parse rate**

The architectural ceiling is 1071/1082 Pike-distribution files (99.0%). Confirm
it has not moved.

- [ ] **Step 2: Both Roxen sweeps, diffed against the baseline**

```bash
S=/tmp/.../scratchpad
bun run tools/lsp-audit/wrong-target-sweep.ts --root /tank/projects/roxen-6.1/server/etc --dumpall $S/all-grammar.txt
bun run tools/lsp-audit/symbol-integrity-sweep.ts --root /tank/projects/roxen-6.1/server/etc
```

Diff `all-grammar.txt` against the pre-change dump and check the
`ok -> not ok` transitions specifically. **Zero regressions is the bar** — the
grammar's own suite will not catch these, which is the whole reason this step
exists.

- [ ] **Step 3: Verify the original symptom is actually fixed end to end**

```bash
bun test tests/lsp/incompleteStatementRange.test.ts   # from Branch A, if written
```

- [ ] **Step 4: Commit and open the PR**

```bash
git commit --allow-empty -m "test: validate the collapsed expression spine against Roxen"
gh pr create --base main --title "fix: collapse the expression unit-production spine"
```

---

## Self-Review

**Spec coverage.** The request was "plan the grammar cascade rewrite". The plan
covers it, but inverts the framing: the rewrite's premise is already disproven at
the granularity that was proposed, so Task 1 is a gate rather than step one of a
migration. Both outcomes have a complete branch.

**Placeholders.** Task 1 Step 3's rule is explicitly a spike shape, not a
deliverable, and says so. Task B1 Step 1 leaves a genuine decision (naming
option (a) vs (b)) to be made from the gate result — that is a decision point,
not a placeholder, and it names both options and the criterion.

**Type consistency.** `declRangeWithoutAbsorbed` (Task A2) returns the same
`Range` shape `toRange` produces. `countCommasInNode` (Task B3) is named as it
exists today in `signatureHelp.ts`.

**Known weakness.** Task 1's spike shape may not generate without conflicts on
the first attempt; the step says to resolve conflicts only far enough to answer
the question. If the spike cannot be made to generate at all, that is itself a
gate failure — record it and take Branch A.
