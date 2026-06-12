# Data Model: Tiger Style Enforcement Gate

## Style Rule

A machine-verifiable Tiger Style requirement that the gate can enforce.

Fields:
- `id`: Stable detector-facing identifier, for example `max-function-lines`.
- `source`: AGENTS.md section or line reference that motivates the rule.
- `description`: Human-readable rule description.
- `checkName`: Name emitted in findings and used by the rule catalog.
- `severity`: `blocking` for machine-verifiable violations.
- `flags`: CLI flags that run the rule independently and through `--all`.
- `limit`: Optional numeric or symbolic limit, such as `50 lines`, `500 lines`, `4 levels`, or `20 exports`.

Validation rules:
- Every machine-verifiable AGENTS.md rule has exactly one catalog entry.
- Every blocking rule has at least one detector path and one fixture proving violation detection.
- Human-judgment guidance is excluded from blocking rules and may appear only as an advisory signal.

Relationships:
- A Style Rule can produce many Findings.
- A Style Rule can have zero or more Suppressions.
- A Style Rule belongs to exactly one Rule Catalog.

## Rule Catalog

Machine-readable mapping from AGENTS.md Tiger Style rules to detector checks.

Fields:
- `version`: Catalog schema version.
- `rules`: Ordered list of Style Rule entries.
- `advisorySignals`: Optional list of local-only warnings for review-only guidance or drift.

Validation rules:
- Catalog references must be stable enough for review.
- Catalog check names must match detector output exactly.
- `--all` must include every blocking rule unless a rule documents why it is unavailable.

## Finding

A single detected rule violation.

Fields:
- `ruleId`: Style Rule identifier.
- `checkName`: Detector check name shown to the user.
- `path`: Repository-relative path.
- `line`: 1-indexed line number.
- `message`: Concise actionable explanation.
- `severity`: `failure` for blocking violations or `warning` for advisory local signals.

Validation rules:
- Blocking findings make the gate exit non-zero.
- Warning-only findings do not block PR CI.
- Findings must include rule name, file, and line.
- Findings must avoid substring false positives, such as `AUTODOC` matching `TODO`.

## Suppression

A documented exception for a known acceptable violation.

Fields:
- `ruleId`: Style Rule identifier being suppressed.
- `path`: Repository-relative path.
- `range`: Line or line range covered by the exception.
- `justification`: Reviewable reason the exception is legitimate.
- `reviewer`: Reviewer or approving maintainer.
- `reviewedDate`: Date of review.

Validation rules:
- Suppressions without all required fields are invalid.
- Suppressions apply only to the exact rule and path/range recorded.
- Inline silent disables are not valid suppressions.
- Stale suppressions that match no finding should be reported as advisory drift.

## Advisory Signal

A local non-blocking warning for review-only guidance or catalog drift.

Fields:
- `id`: Stable identifier.
- `message`: Human-readable warning.
- `path`: Optional repository-relative path.
- `line`: Optional 1-indexed line number.

Validation rules:
- Advisory signals do not fail PR CI.
- Advisory signals must not be used to downgrade machine-verifiable violations.

## State Transitions

Finding lifecycle:

```text
Detected -> Suppressed -> Clean
Detected -> Fixed -> Clean
Detected -> AdvisoryOnly -> Clean
```

Rule catalog lifecycle:

```text
AGENTS.md rule added -> Catalog missing (advisory drift) -> Detector implemented -> Blocking rule covered
AGENTS.md rule removed -> Catalog stale (advisory drift) -> Catalog updated
```
