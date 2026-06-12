# Implementation Plan: Tiger Style Enforcement Gate

**Branch**: `002-tiger-style-enforcement` | **Date**: 2026-06-12 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-tiger-style-enforcement/spec.md`

## Summary

Expand the existing `scripts/quality-gates.sh` wrapper and its vendored detector so it enforces every machine-verifiable Tiger Style rule documented in AGENTS.md, then remediate the current codebase until the expanded gate passes cleanly. The implementation keeps the current Bash/Python detector shape, adds a machine-readable rule catalog and repository-level suppression registry, preserves per-rule flags plus `--all`, and verifies the project-local and Hermes skill detector copies remain byte-identical.

## Technical Context

**Language/Version**: TypeScript 6.0.3 for the LSP codebase; Bash plus embedded Python 3 for the quality-gates detector.

**Primary Dependencies**: Bun test/build toolchain, TypeScript, existing `scripts/quality-gates.sh`, vendored `.omp/skills/quality-gates/scripts/detect.sh`, synchronized Hermes skill copy at `~/.hermes/skills/pike-lsp/pike-lsp-quality-gates/scripts/detect.sh`.

**Storage**: Repository files only: machine-readable rule catalog, repository-level suppressions registry, detector scripts, tests/fixtures, documentation updates.

**Testing**: Strict RED-GREEN TDD using Bun tests for detector fixtures where practical, plus direct `bash scripts/quality-gates.sh` invocations for end-to-end gate behavior; final validation with `bun run typecheck`, `bun run build`, and `bun run test`.

**Target Platform**: Linux CI and local developer machines running Node 22+, Bun, Bash, and Python 3 from the existing repository toolchain.

**Project Type**: VSCode extension and TypeScript LSP repository with a repository-local CLI-style quality gate.

**Performance Goals**: `bash scripts/quality-gates.sh --all` completes in under five seconds on a typical development machine while scanning the full source tree.

**Constraints**: Preserve existing per-flag and `--all` contract; CI must block only machine-verifiable violations; local advisory/drift signals may warn without failing PRs; no silent inline disables; exceptions must live in the repository-level suppressions registry.

**Scale/Scope**: Current repository source tree, including `server/src`, `client`, tests, scripts, and synchronized detector copies; module export limit is twenty public symbols and nesting depth limit is four levels.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The checked-in `.specify/memory/constitution.md` still contains template placeholders and defines no active project-specific gates. Planning therefore applies the repository governance in AGENTS.md:

- **Read before editing**: PASS. Existing spec, manifest, CI workflow, quality-gates wrapper, vendored detector, and quality-gates skill were inspected before planning.
- **Tiger Style limits**: PASS. The plan makes file length, function length, nesting depth, module export count, bounded loops, documented skips, and linked TODO/FIXME/HACK/XXX markers explicit gate concerns.
- **No lying success**: PASS. The plan adds rule catalog coverage and blocking semantics so zero exit means no machine-verifiable violations.
- **Tests are ground truth**: PASS. Each new detector rule is planned with failing fixtures before implementation and an end-to-end gate run after implementation.
- **No silently ignored defects**: PASS. Suppressions require a repository-level audited entry with rule, path/range, justification, and reviewer/date.
- **One concern per change**: PASS. The plan is scoped to Tiger Style enforcement and codebase remediation only.

## Project Structure

### Documentation (this feature)

```text
specs/002-tiger-style-enforcement/
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   └── quality-gates-cli.md
└── tasks.md
```

### Source Code (repository root)

```text
scripts/
└── quality-gates.sh                    # Stable wrapper invoked by developers and CI

.omp/skills/quality-gates/
└── scripts/detect.sh                   # Project-local vendored detector used by wrapper

~/.hermes/skills/pike-lsp/pike-lsp-quality-gates/
└── scripts/detect.sh                   # Synchronized agent skill detector copy

.github/workflows/
└── ci.yml                              # Existing quality-gates job invokes --all

server/src/
└── features/scope-helpers.ts           # Known module-export remediation target

tests/
└── quality-gates/                      # Detector fixture tests and malformed examples
```

**Structure Decision**: Keep the existing wrapper plus vendored detector structure. Add catalog, suppression registry, fixtures, and tests adjacent to the detector contract rather than introducing a third-party linter or a new service. The wrapper remains the public entrypoint for CI and developers.

## Phase 0: Research Summary

See [research.md](./research.md) for completed decisions. All planning unknowns were resolved from the clarified spec and repository inspection.

## Phase 1: Design Summary

- Data model: [data-model.md](./data-model.md)
- CLI/output contract: [contracts/quality-gates-cli.md](./contracts/quality-gates-cli.md)
- Validation guide: [quickstart.md](./quickstart.md)

## Post-Design Constitution Check

- **Read before editing**: PASS. Design artifacts reference inspected repository paths and current contracts.
- **Tiger Style limits**: PASS. The data model represents style rules, findings, suppressions, advisory signals, and rule catalog coverage.
- **No lying success**: PASS. CLI contract distinguishes blocking failures from non-blocking warnings.
- **Tests are ground truth**: PASS. Quickstart requires fixture-based RED evidence and clean-tree GREEN evidence before full validation.
- **No silently ignored defects**: PASS. Suppression registry fields are mandatory and reviewable.
- **One concern per change**: PASS. Contracts are limited to quality-gates behavior and synchronized detector maintenance.

## Complexity Tracking

No constitution violations or exceptional complexity are required. The feature extends the existing quality-gates architecture rather than adding a new subsystem.
