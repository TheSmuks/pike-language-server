# Contract: Quality Gates CLI

## Entrypoint

```bash
bash scripts/quality-gates.sh [--all|--functions|--nonnull|--catch|--roottext|--unbounded|--importmeta|--filelen|--nesting|--exports|--loops|--markers|--skips|--catalog]
```

`scripts/quality-gates.sh` remains the stable public command. It delegates to `.omp/skills/quality-gates/scripts/detect.sh` when present and falls back to the Hermes skill copy only for local agent usage.

## Required Flags

Existing flags must remain supported:
- `--all`
- `--functions`
- `--nonnull`
- `--catch`
- `--roottext`
- `--unbounded`
- `--importmeta`
- `--filelen`

New independent flags:
- `--nesting`: fail functions or blocks nested deeper than four levels.
- `--exports`: fail modules exporting more than twenty public symbols.
- `--loops`: fail non-finite loops without explicit bound or proof comment.
- `--markers`: fail bare `TODO`, `FIXME`, `HACK`, or `XXX` markers without a tracked issue reference.
- `--skips`: fail skipped tests without a documented reason.
- `--catalog`: check rule catalog coverage against detector check names and AGENTS.md references.

`--all` must run every blocking machine-verifiable rule.

## Exit Status

- `0`: No blocking machine-verifiable violations were found. Warning-only advisory signals may be present.
- `1`: One or more blocking violations were found.
- `2`: CLI usage error, invalid catalog, invalid suppression registry, or other detector setup error.

## Output Requirements

Every blocking finding must include:
- Rule/check name.
- Repository-relative file path.
- 1-indexed line number.
- Short actionable message.

Recommended output shape:

```text
=== TigerStyle: Module exports over 20 ===
[FAIL] max-module-exports server/src/features/scope-helpers.ts:1 — 23 exports exceeds limit 20

=== Summary ===
1 failure(s), 0 warning(s)
```

Warning-only advisory signals use `[WARN]` and must not change exit status from zero when no blocking failures exist.

## Suppression Registry Contract

The detector must read a repository-level suppressions registry. Each suppression must provide:
- `ruleId`
- `path`
- `range`
- `justification`
- `reviewer`
- `reviewedDate`

Invalid suppression entries are setup errors and return exit status `2`.

## Rule Catalog Contract

The machine-readable rule catalog must map each enforceable AGENTS.md Tiger Style rule to a detector check name. Catalog drift should warn locally and may be validated by `--catalog`.

Required catalog entry fields:
- `id`
- `source`
- `checkName`
- `description`
- `severity`
- `flags`

## Synchronization Contract

After detector changes, the project-local detector and Hermes skill detector must compare byte-identical:

```bash
diff -u ~/.hermes/skills/pike-lsp/pike-lsp-quality-gates/scripts/detect.sh .omp/skills/quality-gates/scripts/detect.sh
```

The wrapper comment in `scripts/quality-gates.sh` must remain accurate when flags or detector paths change.
