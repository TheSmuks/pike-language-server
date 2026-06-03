# Branch Protection Required Checks

This repository relies on GitHub branch protection for `main`. The protection
rule should require the checks below before a pull request can merge. These are
expected status-check names after the runtime QA and CI remediation work.

## Required CI gates

From `.github/workflows/ci.yml`:

- `repository-guards`
- `typecheck (ubuntu-latest)`
- `typecheck (macos-latest)`
- `typecheck (windows-latest)`
- `pike-fmt`
- `unit-tests (ubuntu-latest)`
- `unit-tests (macos-latest)`
- `unit-tests (windows-latest)`
- `quality-gates`
- `smoke-test`
- `vscode-integration`
- `test`

From standalone policy workflows:

- `changelog-check`
- `commit-lint`
- `check-blob-sizes`

## Verification procedure

Use GitHub settings or the API to confirm the required-check set:

```bash
gh api repos/TheSmuks/pike-language-server/branches/main/protection/required_status_checks \
  --jq '.contexts[]' | sort
```

The sorted output should match the list above. If the repository uses GitHub's
new rulesets UI instead of classic branch protection, inspect the active ruleset
for `main` and confirm the same required check names are present.

## Deferred hardening

Third-party actions are not SHA-pinned in this change. Dependabot already tracks
`actions/*`, `oven-sh/setup-bun`, and `wagoid/commitlint-github-action`, so action
SHA pinning is a follow-up hardening task rather than a functional blocker.
