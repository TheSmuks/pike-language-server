# Research: Tiger Style Enforcement Gate

## Decision: Keep `scripts/quality-gates.sh` as the stable public entrypoint

**Rationale**: The wrapper is already used by CI (`.github/workflows/ci.yml`) and by developers. It delegates to the project-local vendored detector first, then the Hermes skill copy as fallback. Keeping this contract avoids changing CI wiring or developer habits while allowing the detector implementation to expand.

**Alternatives considered**:
- Replace with a TypeScript CLI: rejected because it would add build/runtime coupling before the gate can run.
- Use a third-party linter: rejected because the rules are project-specific Tiger Style policy and must remain coupled to AGENTS.md.

## Decision: Extend the vendored Bash detector with embedded Python helpers where structure matters

**Rationale**: Existing checks already use Bash orchestration and embedded Python for function-length parsing. New checks such as nesting depth, module export count, loop boundedness, and skip-marker detection can follow the same pattern without introducing new dependencies.

**Alternatives considered**:
- Pure grep checks for every rule: rejected because nesting depth, whole-marker matching, skip reasons, and loop boundedness need context to avoid false positives.
- Full TypeScript AST parser dependency: rejected for planning because the current gate must remain dependency-light and runnable before install/build when possible.

## Decision: Add a machine-readable rule catalog

**Rationale**: The clarified spec requires every enforceable AGENTS.md rule to map to a detector check name. A machine-readable catalog makes drift detectable and lets tests verify coverage without manual checklist comparison.

**Alternatives considered**:
- Markdown checklist: rejected because it is reviewable but not reliably machine-verifiable.
- Gate output-only listing: rejected because output alone does not preserve AGENTS.md source mapping or coverage metadata.

## Decision: Use a repository-level suppressions registry, not inline disables

**Rationale**: Suppressions must be auditable and reviewable. A central registry with rule, path/range, justification, and reviewer/date makes exceptions visible in review and prevents source-local comments from silently weakening policy.

**Alternatives considered**:
- Inline comments with issue links: rejected because they scatter exceptions and can become invisible during broad reviews.
- Decision documents only: rejected because detector consumption and range matching would require a second parser over prose.

## Decision: Blocking failures are limited to machine-verifiable violations

**Rationale**: CI should fail on concrete rule violations, while advisory/drift signals may warn locally without blocking PRs. This keeps the gate authoritative without pretending review-only style judgments can be automated.

**Alternatives considered**:
- Fail every catalog entry: rejected because AGENTS.md includes human-judgment guidance like naming quality and abstraction choice.
- Report everything as warnings: rejected because machine-verifiable violations must block PRs.

## Decision: Treat finite collection/range iteration as bounded

**Rationale**: The clarified spec states finite collection/range iteration is compliant. This prevents noisy annotations for normal `for...of` and range loops while still requiring explicit bounds or proof comments for loops whose termination is not self-evident.

**Alternatives considered**:
- Require numeric bounds on every loop: rejected as too noisy and likely to produce churn without improving safety.
- Check only `while` loops: rejected because unbounded `for` loops can also violate the rule.

## Decision: Validate with fixture-driven RED tests plus end-to-end `--all`

**Rationale**: Each new rule needs a malformed fixture that proves detection, plus a clean-tree end-to-end run that proves low-noise operation. This follows the repository’s TDD preference and avoids relying on hand-waved detector behavior.

**Alternatives considered**:
- Manual script runs only: rejected because regressions in detector heuristics would be easy to miss.
- Unit tests only: rejected because the public contract is the wrapper and its shell exit status/output.
