# Quickstart: Tiger Style Enforcement Gate

## Prerequisites

- Run from repository root: `/tank/projects/pike-language-server`.
- Bun, Node 22+, Bash, and Python 3 are available.
- Dependencies are installed with `bun install` if build/typecheck/test commands are needed.

## 1. Prove the current gap with RED detector fixtures

Create or run fixture tests that intentionally violate each newly covered rule:

- Nesting depth greater than four.
- More than twenty public module exports.
- Non-finite loop without explicit bound or proof comment.
- Bare `TODO`, `FIXME`, `HACK`, or `XXX` without a tracked issue reference.
- Skipped test without documented reason.
- Catalog entry missing for an enforceable AGENTS.md rule.
- Invalid suppression registry entry missing a required field.

Expected outcome before implementation: each fixture test fails because the current detector does not yet flag the violation.

## 2. Validate independent rule flags

After implementation, run each new rule independently:

```bash
bash scripts/quality-gates.sh --nesting
bash scripts/quality-gates.sh --exports
bash scripts/quality-gates.sh --loops
bash scripts/quality-gates.sh --markers
bash scripts/quality-gates.sh --skips
bash scripts/quality-gates.sh --catalog
```

Expected outcome on a clean tree: each command exits `0` with no blocking findings.

Expected outcome on malformed fixtures: each command exits `1` and reports rule name, file, and line.

## 3. Validate the full gate

```bash
bash scripts/quality-gates.sh --all
```

Expected outcome:
- Exit status `0` on the clean source tree.
- Runtime under five seconds on a typical development machine.
- No false positives such as `AUTODOC` being treated as a `TODO` marker.
- Warning-only advisory signals do not cause PR-blocking failure.

## 4. Validate known remediation target

Confirm the current `scope-helpers.ts` export-count violation is fixed by splitting exports into focused modules without breaking imports:

```bash
bash scripts/quality-gates.sh --exports
bun run typecheck
```

Expected outcome:
- No module exports more than twenty public symbols.
- TypeScript import sites still resolve.

## 5. Validate synchronized detector copies

```bash
diff -u ~/.hermes/skills/pike-lsp/pike-lsp-quality-gates/scripts/detect.sh .omp/skills/quality-gates/scripts/detect.sh
```

Expected outcome: no diff.

## 6. Run full repository validation

```bash
bun run typecheck
bun run build
bun run test
bash scripts/quality-gates.sh --all
```

Expected outcome: all commands pass. If any pre-existing failure is discovered, document it per AGENTS.md instead of silently ignoring it.
