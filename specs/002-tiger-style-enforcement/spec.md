# Feature Specification: Tiger Style Enforcement Gate

**Feature Branch**: `002-tiger-style-enforcement`

**Created**: 2026-06-12

**Status**: Draft

**Input**: User description: "enforce tiger style and fix pending work"

## Clarifications

### Session 2026-06-12

- Q: What form must the documented, auditable suppression mechanism take? → A: Repository-level suppressions registry listing rule, path/range, justification, and reviewer/date.
- Q: When is a loop considered bounded for Tiger Style gate enforcement? → A: Finite collection/range iteration is compliant; other loops need explicit bound or proof comment.
- Q: How must the gate make rule coverage auditable against AGENTS.md? → A: Machine-readable rule catalog mapping each enforceable AGENTS.md rule to detector check name.
- Q: Which severities should block pull requests? → A: Machine-verifiable violations fail; advisory/drift signals may warn locally but not block PRs.
- Q: What is the local full-gate performance target? → A: Full gate completes in under 5 seconds.

## User Scenarios & Testing *(mandatory)*

<!--
  The project already documents its coding standard — an adapted Tiger Style —
  in AGENTS.md, and already ships a quality-gates detector covering seven of
  those rules. This feature closes the gap between what the standard promises
  and what the gate actually enforces, then makes the codebase pass clean.
-->

### User Story 1 - Full Rule Coverage (Priority: P1)

A maintainer wants every machine-verifiable rule in the project's Tiger Style
standard to be checked automatically, so that a "green" gate genuinely means the
code complies with the documented standard — not merely the subset the detector
happened to cover.

Today the gate checks seven rules (function length, file length, non-null
assertions on tree-sitter nodes, silent catch blocks, unbounded Map/Set,
rootNode.text materialization, and import.meta non-null assertions). Several
rules stated in AGENTS.md are not checked at all: nesting depth must not exceed
four levels; a module must not export more than twenty public symbols; every
loop must have a proven or explicit upper bound (not just Map/Set containers);
bare TODO/FIXME/HACK/XXX markers must link to a tracked issue; and skipped
tests must carry a documented reason. As long as these go unchecked, the gate
can report success while the standard is violated — a "lying" success, which the
standard itself forbids.

**Why this priority**: A gate that enforces only part of the standard is worse
than no gate, because a green run lulls maintainers into trusting compliance that
does not exist. Closing coverage is the foundation; every other story depends on
the gate being able to detect a violation before it can require one to be fixed.

**Independent Test**: Run the gate with a deliberately malformed fixture file
that breaks each previously-unchecked rule, and confirm the gate flags each one
with the rule name and location.

**Acceptance Scenarios**:

1. **Given** a source file containing a function nested five levels deep, **When**
   the maintainer runs the gate, **Then** it reports the file, line, and nesting
   depth as a failure.
2. **Given** a source file exporting twenty-one public symbols, **When** the gate
   runs, **Then** it reports the file and export count as a failure.
3. **Given** a loop that is not finite collection/range iteration and has no
   explicit upper bound or proof comment, **When** the gate runs, **Then** it
   flags the loop for a missing bound.
4. **Given** a source line containing a bare `TODO` with no linked issue, **When**
   the gate runs, **Then** it reports the location and requires an issue
   reference, without false-matching identifiers that merely contain the
   substring (for example `AUTODOC`).
5. **Given** a skipped test with no explanatory comment, **When** the gate runs,
   **Then** it reports the skipped test and requires a documented reason.

---

### User Story 2 - Clean Codebase (Priority: P2)

A maintainer wants the existing codebase to pass the expanded gate with zero
failures, so that the standard is not merely written down but actually upheld
across the code that already exists.

An audit of the current code against the uncovered rules already surfaced at
least one real violation: `server/src/features/scope-helpers.ts` exports
twenty-three public symbols, exceeding the twenty-symbol module boundary. Other
rules may surface further findings once enforced. "Fix pending work" means
bringing every such finding into compliance — by splitting oversized modules,
bounding loops explicitly, linking or removing stray markers, and documenting
skips — so that the gate exits green on `main`.

**Why this priority**: A standard that the codebase itself breaks cannot be
enforced on new contributions without hypocrisy. Making the existing code pass
is what turns the gate from a wish into authority. It must follow coverage
(P1), because violations can only be fixed once they can be detected.

**Independent Test**: Run the expanded gate against the full source tree on the
default branch and confirm it exits zero with no failures.

**Acceptance Scenarios**:

1. **Given** the current source tree, **When** the expanded gate runs with all
   checks enabled, **Then** it reports zero failures.
2. **Given** `scope-helpers.ts` currently exporting twenty-three symbols, **When**
   the fix lands, **Then** no single module exports more than twenty public
   symbols and all existing import sites continue to resolve.
3. **Given** any loop previously lacking an explicit bound, **When** the fix lands,
   **Then** each such loop either proves termination in a comment or carries an
   explicit upper-bound guard.

---

### User Story 3 - Authoritative, Low-Noise Gate (Priority: P3)

A maintainer wants the gate to be the single source of truth for style
compliance — trustworthy enough to block a pull request, fast enough to run
locally before every commit, and free of false positives that would train
developers to ignore it.

The detector lives in two synchronized copies (a project-local vendored copy and
a shared agent skill) that must stay byte-identical, and its output must name the
offending rule, file, and line so a developer can act immediately. False
positives — such as substring matches inside unrelated identifiers — erode trust
and must not occur. The gate already runs in continuous integration; this story
ensures it remains the authoritative check as new rules are added.

**Why this priority**: Authority and developer experience sustain the gate over
time. Without them, even a complete, passing gate gets bypassed. This story is
last because it polishes the foundation laid by P1 and P2.

**Independent Test**: Run the gate locally with `--all` and confirm it completes
quickly, produces no false positives on the clean tree, and that its two detector
copies are byte-identical.

**Acceptance Scenarios**:

1. **Given** a clean working tree, **When** the maintainer runs the gate locally,
   **Then** it completes in under five seconds, reports success, and names no
   false violations.
2. **Given** the two detector copies, **When** compared, **Then** they are
   byte-identical, and the project documents that they must be updated together.
3. **Given** a continuous-integration run on a pull request, **When** the
   quality-gates job executes, **Then** it fails the build on any Tiger Style
   violation introduced by the change.

---

### Edge Cases

- What happens when a rule has a legitimate, documented exception (for example a
  module that must export more than twenty symbols by design)? The gate must
  use a repository-level suppressions registry listing rule, path/range,
  justification, and reviewer/date, so exceptions are visible and reviewable.
- What happens when a substring inside an identifier matches a banned pattern
  (for example `AUTODOC` containing `TODO`)? The detector must match whole
  markers, not substrings, to avoid false positives.
- What happens when a loop terminates because its input is finite (for example
  iterating over a collection or range)? The gate must treat finite
  collection/range iteration as compliant, requiring an explicit bound or proof
  comment for other loops.
- What happens when a test is skipped because an external dependency (the Pike
  runtime) is absent? The skip must carry a comment naming the dependency and
  the condition, satisfying the "documented reason" rule without counting as a
  silently ignored defect.
- What happens when a new Tiger Style rule is added to AGENTS.md later? The
  detector's rule set and the standard must stay in sync; the gap between them
  must be auditable.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The gate MUST check every machine-verifiable rule stated in the
  project's Tiger Style standard, including those currently uncovered: maximum
  nesting depth, maximum module exports, loop boundedness, bare markers, and
  undocumented test skips.
- **FR-002**: The gate MUST report each violation with the rule name, the
  offending file, and the line number, so a developer can locate and fix it
  without further investigation.
- **FR-003**: The gate MUST NOT produce false positives, including substring
  matches inside unrelated identifiers.
- **FR-004**: The gate MUST exit non-zero when any machine-verifiable violation
  is present and zero when no blocking violations are present, so continuous
  integration can gate pull requests on its result.
- **FR-005**: The gate MUST allow each rule to be run independently and all rules
  together, preserving the existing per-flag and `--all` invocation contract.
- **FR-006**: The existing codebase MUST pass the expanded gate with zero
  failures on the default branch, including resolving the module-export
  violation in `scope-helpers.ts`.
- **FR-007**: Any module exceeding the export limit MUST be split into focused
  modules without breaking existing import sites, mirroring the established
  extract-and-re-export pattern already used in the codebase.
- **FR-008**: Finite collection/range iteration MUST be treated as bounded;
  every other loop MUST have an explicit upper-bound guard or a comment proving
  termination.
- **FR-009**: The gate MUST provide a repository-level suppressions registry for
  legitimate rule exceptions, recording the rule, path/range, justification, and
  reviewer/date for each suppression.
- **FR-010**: The detector's two synchronized copies (project-local vendored copy
  and shared agent skill) MUST remain byte-identical, and any rule change MUST
  update both in the same change.
- **FR-011**: The gate MUST remain wired into continuous integration as a
  required check on pull requests targeting the default branch, blocking on
  machine-verifiable violations while allowing advisory/drift signals to warn
  locally without blocking pull requests.
- **FR-012**: The gate MUST provide a machine-readable rule catalog mapping each
  enforceable AGENTS.md rule to a detector check name, so future divergence
  between the standard and the detector is detectable.

### Key Entities *(include if feature involves data)*

- **Style Rule**: A single machine-verifiable Tiger Style injunction (for example
  "function length at most fifty lines"), carrying a stable name, a blocking
  severity, and a description. Rules are the unit of enforcement and reporting.
- **Rule Catalog**: A machine-readable mapping from each enforceable AGENTS.md
  Tiger Style rule to its detector check name, used to audit coverage and detect
  drift between the standard and the gate.
- **Advisory Signal**: A non-blocking local warning for drift or review-only
  style guidance that should inform maintainers without failing pull-request CI.
- **Finding**: A single detected violation, tying a Style Rule to a file and line.
  Findings are the gate's output and the developer's unit of work.
- **Suppression**: A documented, reviewable exception attaching a Style Rule to a
  path/range in the repository-level suppressions registry with a justification
  and reviewer/date, so the gate can skip a known-acceptable case without
  silencing future violations elsewhere.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Every machine-verifiable rule in the project's Tiger Style standard
  has a corresponding gate check in the machine-readable rule catalog, verifiable
  by mapping each documented rule to a named check.
- **SC-002**: The expanded gate reports zero failures when run with all checks
  enabled against the full source tree on the default branch.
- **SC-003**: A fixture breaking each previously-uncovered rule is flagged by the
  gate with the correct rule name and location, with zero false positives across
  one hundred percent of the clean tree.
- **SC-004**: No module in the source tree exports more than twenty public
  symbols after the codebase is brought into compliance.
- **SC-005**: Developers can run the full gate locally and receive a definitive
  pass or fail result within five seconds on a typical development machine.
- **SC-006**: The two detector copies are byte-identical and remain so after the
  change, verifiable by a direct comparison.

## Assumptions

- The project's Tiger Style standard, as documented in AGENTS.md, is the
  authoritative source of rules; this feature enforces that standard rather than
  inventing new rules.
- Rules that require human judgment (naming quality, comment quality, abstraction
  choice, simplicity) remain unenforced by automation and are addressed only by
  review; only machine-verifiable rules are in scope.
- The existing extract-and-re-export refactoring pattern, already used to keep
  files under the line limit, is the accepted way to resolve module-export
  violations without disturbing import sites.
- The Pike runtime's absence is a legitimate reason to skip a test, provided the
  skip is documented; such skips are not silently ignored defects.
- The detector continues to be implemented as the existing project-local script
  plus its synchronized skill copy, rather than replaced by a third-party linter,
  to keep the rule set tightly coupled to the project's own standard.
