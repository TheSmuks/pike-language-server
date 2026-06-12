# Tasks: Tiger Style Enforcement Gate

**Input**: Design documents from `/specs/002-tiger-style-enforcement/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/quality-gates-cli.md, quickstart.md
**Tests**: Required. The feature specification and quickstart require strict RED-GREEN TDD for detector fixtures and end-to-end gate behavior.
**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel because it touches different files and does not depend on incomplete work.
- **[Story]**: User story label from spec.md; setup, foundational, and polish tasks intentionally omit story labels.
- Every task names an exact repository path or command target.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Establish the files and baseline evidence needed before changing detector behavior.

- [X] T001 Record current quality gate CLI behavior in specs/002-tiger-style-enforcement/evidence/current-quality-gates.txt using `bash scripts/quality-gates.sh --all`.
- [X] T002 [P] Record current detector copy drift in specs/002-tiger-style-enforcement/evidence/current-detector-diff.txt using `diff -u ~/.hermes/skills/pike-lsp/pike-lsp-quality-gates/scripts/detect.sh .omp/skills/quality-gates/scripts/detect.sh`.
- [X] T003 [P] Create detector fixture directory documentation in tests/quality-gates/fixtures/README.md.
- [X] T004 [P] Create quality gate evidence directory documentation in specs/002-tiger-style-enforcement/evidence/README.md.
- [X] T005 Inspect existing CI quality-gates job and record required unchanged workflow target in specs/002-tiger-style-enforcement/evidence/ci-quality-gates-target.txt.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add shared test and policy infrastructure that all user stories depend on.

**Critical**: No user story implementation should begin until this phase is complete.

- [X] T006 Create reusable detector test harness in tests/quality-gates/detectHarness.ts for running `bash scripts/quality-gates.sh` against isolated fixture trees.
- [X] T007 Create quality gate fixture test suite shell in tests/quality-gates/quality-gates.test.ts with RED-GREEN assertions for exit status, stdout, and stderr.
- [X] T008 [P] Add empty suppression registry file in ./quality-gates-suppressions.json with required top-level schema fields.
- [X] T009 [P] Add initial machine-readable rule catalog in ./quality-gates-rules.json covering existing detector rules from AGENTS.md.
- [X] T010 Update scripts/quality-gates.sh usage comment to include every documented existing and planned flag from specs/002-tiger-style-enforcement/contracts/quality-gates-cli.md.
- [X] T011 Update .omp/skills/quality-gates/scripts/detect.sh argument parsing to return exit status 2 for unknown flags and invalid detector setup.

**Checkpoint**: Test harness, catalog, suppression registry, and CLI setup behavior are ready for story work.

---

## Phase 3: User Story 1 - Full Rule Coverage (Priority: P1) MVP

**Goal**: The gate detects every newly covered machine-verifiable Tiger Style rule and reports each violation with rule name, file, and line.

**Independent Test**: Run malformed fixtures that violate nesting depth, module export count, loop boundedness, bare markers, undocumented skips, catalog coverage, and suppression validation; confirm each violation is reported by rule name and location.

### Tests for User Story 1

Write these tests first and confirm they fail before implementation.

- [X] T012 [P] [US1] Add nesting-depth violation fixture in tests/quality-gates/fixtures/nesting-depth/bad.ts.
- [X] T013 [P] [US1] Add module-export violation fixture in tests/quality-gates/fixtures/module-exports/bad.ts.
- [X] T014 [P] [US1] Add unbounded-loop violation fixture in tests/quality-gates/fixtures/loop-bounds/bad.ts.
- [X] T015 [P] [US1] Add bare-marker violation fixture in tests/quality-gates/fixtures/markers/bad.ts.
- [X] T016 [P] [US1] Add undocumented-skip violation fixture in tests/quality-gates/fixtures/skipped-tests/bad.test.ts.
- [X] T017 [P] [US1] Add invalid catalog fixture in tests/quality-gates/fixtures/catalog-invalid/quality-gates-rules.json.
- [X] T018 [P] [US1] Add invalid suppression fixture in tests/quality-gates/fixtures/suppressions-invalid/quality-gates-suppressions.json.
- [X] T019 [US1] Add RED assertions for new detector flags in tests/quality-gates/quality-gates.test.ts using `bun test tests/quality-gates/quality-gates.test.ts`.

### Implementation for User Story 1

- [X] T020 [US1] Implement `--nesting` detection in .omp/skills/quality-gates/scripts/detect.sh with maximum nesting depth 4 and file:line findings.
- [X] T021 [US1] Implement `--exports` detection in .omp/skills/quality-gates/scripts/detect.sh with maximum 20 public exports per module.
- [X] T022 [US1] Implement `--loops` detection in .omp/skills/quality-gates/scripts/detect.sh for non-finite loops lacking explicit bound or proof comment.
- [X] T023 [US1] Implement `--markers` detection in .omp/skills/quality-gates/scripts/detect.sh for whole-word TODO, FIXME, HACK, and XXX markers without issue links.
- [X] T024 [US1] Implement `--skips` detection in .omp/skills/quality-gates/scripts/detect.sh for `test.skip`, `describe.skip`, and Bun skip forms without documented reason.
- [X] T025 [US1] Implement `--catalog` validation in .omp/skills/quality-gates/scripts/detect.sh against quality-gates-rules.json.
- [X] T026 [US1] Implement suppression registry validation and exact path/range matching in .omp/skills/quality-gates/scripts/detect.sh using quality-gates-suppressions.json.
- [X] T027 [US1] Update ./quality-gates-rules.json with new blocking rules, AGENTS.md source references, flags, severities, and detector check names.
- [X] T028 [US1] Wire `--all` to run `--nesting`, `--exports`, `--loops`, `--markers`, `--skips`, and `--catalog` in .omp/skills/quality-gates/scripts/detect.sh.
- [X] T029 [US1] Copy the updated detector to /home/smuks/.hermes/skills/pike-lsp/pike-lsp-quality-gates/scripts/detect.sh and preserve byte-identical content.
- [X] T030 [US1] Prove GREEN fixture behavior with `bun test tests/quality-gates/quality-gates.test.ts`.

**Checkpoint**: User Story 1 is complete when every newly covered rule fails on malformed fixtures, passes on clean fixtures, and is included in `--all`.

---

## Phase 4: User Story 2 - Clean Codebase (Priority: P2)

**Goal**: The current repository passes the expanded gate with zero blocking failures.

**Independent Test**: Run `bash scripts/quality-gates.sh --all` against the repository root and confirm exit status 0 with no failures.

### Tests for User Story 2

Write these tests or checks first and confirm they expose current violations before remediation.

- [X] T031 [US2] Capture RED expanded gate output in specs/002-tiger-style-enforcement/evidence/red-expanded-gate.txt using `bash scripts/quality-gates.sh --all`.
- [X] T032 [P] [US2] Add import-preservation test coverage for scope helper exports in tests/quality-gates/scope-helpers-exports.test.ts.

### Implementation for User Story 2

- [X] T033 [US2] Split public exports from server/src/features/scope-helpers.ts into focused modules under server/src/features/ without exceeding 20 exports per file.
- [X] T034 [US2] Update all import sites that consume scope helpers in server/src/ to preserve existing TypeScript resolution.
- [X] T035 [US2] Remediate any loop-bound findings reported by the expanded gate in server/src/ with explicit upper bounds or proof comments.
- [X] T036 [US2] Remediate any bare marker findings reported by the expanded gate in server/src/, tests/, harness/, scripts/, and docs/ by linking issues or removing stale markers.
- [X] T037 [US2] Remediate undocumented skipped tests in tests/**/*.ts and harness/**/*.ts with documented reasons tied to the skip condition.
- [X] T038 [US2] Prove GREEN clean-tree gate behavior with `bash scripts/quality-gates.sh --all` and save output in specs/002-tiger-style-enforcement/evidence/green-expanded-gate.txt.
- [X] T039 [US2] Prove TypeScript imports still resolve with `bun run typecheck`.

**Checkpoint**: User Story 2 is complete when the expanded gate and TypeScript typecheck pass on the current codebase.

---

## Phase 5: User Story 3 - Authoritative, Low-Noise Gate (Priority: P3)

**Goal**: The gate remains fast, synchronized, CI-authoritative, and free of known false positives.

**Independent Test**: Run `bash scripts/quality-gates.sh --all`, confirm runtime under five seconds, verify no false positives on clean tree, and verify detector copies are byte-identical.

### Tests for User Story 3

Write these tests or checks first and confirm they fail or document current gaps before implementation.

- [X] T040 [P] [US3] Add false-positive marker fixture in tests/quality-gates/fixtures/markers/clean-autodoc.ts.
- [X] T041 [P] [US3] Add bounded loop clean fixture in tests/quality-gates/fixtures/loop-bounds/clean-bounded.ts.
- [X] T042 [P] [US3] Add documented skip clean fixture in tests/quality-gates/fixtures/skipped-tests/clean-documented.test.ts.
- [X] T043 [US3] Add low-noise and clean-fixture assertions in tests/quality-gates/quality-gates.test.ts.

### Implementation for User Story 3

- [X] T044 [US3] Refine marker matching in .omp/skills/quality-gates/scripts/detect.sh so identifiers such as AUTODOC do not match TODO.
- [X] T045 [US3] Refine loop matching in .omp/skills/quality-gates/scripts/detect.sh so finite collection and bounded range iteration pass without annotations.
- [X] T046 [US3] Refine skip matching in .omp/skills/quality-gates/scripts/detect.sh so documented environment-dependent skips pass.
- [X] T047 [US3] Document synchronized detector maintenance in scripts/quality-gates.sh and .omp/skills/quality-gates/SKILL.md.
- [X] T048 [US3] Verify detector copies are byte-identical with `diff -u ~/.hermes/skills/pike-lsp/pike-lsp-quality-gates/scripts/detect.sh .omp/skills/quality-gates/scripts/detect.sh`.
- [X] T049 [US3] Verify local full-gate runtime under five seconds with `time bash scripts/quality-gates.sh --all` and save output in specs/002-tiger-style-enforcement/evidence/full-gate-runtime.txt.
- [X] T050 [US3] Confirm CI still invokes the authoritative gate by inspecting .github/workflows/ci.yml and recording the quality-gates job in specs/002-tiger-style-enforcement/evidence/ci-quality-gates-final.txt.

**Checkpoint**: User Story 3 is complete when the gate is low-noise on clean fixtures, fast locally, synchronized across detector copies, and still wired into CI.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final verification, documentation, and cleanup across all stories.

- [X] T051 [P] Update specs/002-tiger-style-enforcement/quickstart.md with final commands and expected outputs if implementation changes command behavior.
- [X] T052 [P] Update ./CHANGELOG.md under [Unreleased] for the user-facing quality gate expansion.
- [X] T053 [P] Update ./AGENTS.md quality-gate references if any rule names, thresholds, or suppression registry paths changed.
- [X] T054 Run full validation command target `bun run typecheck`.
- [X] T055 Run full validation command target `bun run build`.
- [X] T056 Run full validation command target `bun run test`.
- [X] T057 Run final quality gate command target `bash scripts/quality-gates.sh --all`.
- [X] T058 Run final detector synchronization command target `diff -u ~/.hermes/skills/pike-lsp/pike-lsp-quality-gates/scripts/detect.sh .omp/skills/quality-gates/scripts/detect.sh`.
- [X] T059 Check git working tree target with `git status --short` and remove temporary files not listed in specs/002-tiger-style-enforcement/evidence/README.md.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Phase 1: Setup** has no dependencies and can start immediately.
- **Phase 2: Foundational** depends on Phase 1 and blocks all user story implementation.
- **Phase 3: User Story 1** depends on Phase 2 and is the MVP.
- **Phase 4: User Story 2** depends on User Story 1 because the codebase cannot be remediated against rules that do not exist yet.
- **Phase 5: User Story 3** depends on User Story 1 for detector behavior and should run after User Story 2 to measure low-noise clean-tree behavior.
- **Phase 6: Polish** depends on whichever user stories are included in the delivery scope.

### User Story Dependencies

- **User Story 1 (P1)**: Starts after foundational tasks; no dependency on other user stories.
- **User Story 2 (P2)**: Depends on User Story 1 detector coverage; independently testable by full gate and typecheck.
- **User Story 3 (P3)**: Depends on User Story 1 detector coverage and benefits from User Story 2 remediation; independently testable by fixtures, runtime, diff, and CI inspection.

### Within Each User Story

- Tests and malformed fixtures must be written first and observed RED.
- Detector implementation follows tests.
- Synchronized Hermes skill detector copy updates happen after project-local detector changes.
- Story validation commands must pass before moving to the next story.

### Parallel Opportunities

- T002, T003, T004, T008, T009 can run while T001 and T005 are being recorded because they touch separate files.
- T012 through T018 can run in parallel because each task creates a separate fixture file.
- T020 through T026 should run sequentially in one detector file to avoid merge conflicts.
- T032 can run in parallel with T031 because it creates an independent test file.
- T040, T041, and T042 can run in parallel because each task creates a separate clean fixture file.
- T051, T052, and T053 can run in parallel because they update separate documentation files.

---

## Parallel Example: User Story 1

```bash
Task: "Add nesting-depth violation fixture in tests/quality-gates/fixtures/nesting-depth/bad.ts"
Task: "Add module-export violation fixture in tests/quality-gates/fixtures/module-exports/bad.ts"
Task: "Add unbounded-loop violation fixture in tests/quality-gates/fixtures/loop-bounds/bad.ts"
Task: "Add bare-marker violation fixture in tests/quality-gates/fixtures/markers/bad.ts"
Task: "Add undocumented-skip violation fixture in tests/quality-gates/fixtures/skipped-tests/bad.test.ts"
Task: "Add invalid catalog fixture in tests/quality-gates/fixtures/catalog-invalid/quality-gates-rules.json"
Task: "Add invalid suppression fixture in tests/quality-gates/fixtures/suppressions-invalid/quality-gates-suppressions.json"
```

## Parallel Example: User Story 2

```bash
Task: "Capture RED expanded gate output in specs/002-tiger-style-enforcement/evidence/red-expanded-gate.txt"
Task: "Add import-preservation test coverage for scope helper exports in tests/quality-gates/scope-helpers-exports.test.ts"
```

## Parallel Example: User Story 3

```bash
Task: "Add false-positive marker fixture in tests/quality-gates/fixtures/markers/clean-autodoc.ts"
Task: "Add bounded loop clean fixture in tests/quality-gates/fixtures/loop-bounds/clean-bounded.ts"
Task: "Add documented skip clean fixture in tests/quality-gates/fixtures/skipped-tests/clean-documented.test.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1 setup evidence.
2. Complete Phase 2 shared harness, catalog, suppression registry, and CLI setup handling.
3. Complete Phase 3 User Story 1 with RED fixtures, detector implementation, synchronized copy, and GREEN fixture tests.
4. Stop and validate User Story 1 independently with `bun test tests/quality-gates/quality-gates.test.ts`.

### Incremental Delivery

1. Deliver Setup and Foundational infrastructure.
2. Deliver User Story 1 to close rule coverage and make the gate truthful for malformed fixtures.
3. Deliver User Story 2 to remediate the current repository until the expanded gate passes cleanly.
4. Deliver User Story 3 to harden low-noise behavior, performance, synchronization, and CI authority.
5. Finish with Phase 6 validation and documentation.

### Parallel Team Strategy

1. One engineer owns detector implementation in .omp/skills/quality-gates/scripts/detect.sh to avoid conflicts.
2. Other engineers can create independent fixture files and documentation evidence in parallel.
3. After User Story 1, one engineer remediates server/src/features/scope-helpers.ts while another documents markers/skips findings if the expanded gate reports any.
4. Final validation should be serialized so failures are fixed in priority order: quality gate, typecheck, build, tests, detector diff.

## Notes

- Preserve the public entrypoint `bash scripts/quality-gates.sh`.
- Preserve existing flags while adding `--nesting`, `--exports`, `--loops`, `--markers`, `--skips`, and `--catalog`.
- Do not add inline disables; legitimate exceptions belong in quality-gates-suppressions.json.
- Update both detector copies in the same logical change and verify with the diff command.
- If a pre-existing defect is found during remediation, fix it in scope or document it per AGENTS.md; do not silently ignore it.
