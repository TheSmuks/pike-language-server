---
name: cut-release
description: Cut a clean release — bump versions across all files, update changelog, build VSIX, create GitHub release
category: workflow
tags: [release, versioning, semver, automation]
version: 1.0.0
---

# Cut Release

Automated release workflow for the Pike Language Server: determine version → run pre-flight checks → run `scripts/release.sh` (updates 9 manifest files + builds VSIX) → commit → create PR → merge → tag → publish GitHub release.

## When to Use

Invoke this skill whenever you are ready to cut a new release. Common triggers:
- After merging feature branches that warrant a version bump
- When `[Unreleased]` in `CHANGELOG.md` has accumulated changes worth releasing
- Before publishing a new VSIX to the marketplace

## Prerequisites

- All work for this release is committed and pushed
- `CHANGELOG.md` has entries under `[Unreleased]` (not empty)
- You have push access to the repository

---

## Phase 1: Determine Version (You do this)

1. **Read current version** from `.template-version`:
   ```bash
   cat .template-version
   ```

2. **Read changelog** to understand what has changed under `[Unreleased]`:
   ```bash
   head -30 CHANGELOG.md
   ```

3. **Compute next version** using semver:
   - `feat:` commits → **minor** bump (e.g. `1.2.0` → `1.3.0`)
   - `fix:` commits → **patch** bump (e.g. `1.2.0` → `1.2.1`)
   - `feat!:` or `BREAKING CHANGE` in body → **major** bump (e.g. `1.2.0` → `2.0.0`)
   - Pre-release: append `-beta` or `-alpha` (e.g. `0.3.2` → `0.3.4-beta`)

4. **Ask user to confirm or override** the computed version before proceeding.

> If `[Unreleased]` is empty, abort — nothing to release.

---

## Phase 1.5: Pre-flight Checks (scripts/preflight.sh does this)

Run the pre-flight check script **before** proceeding with the release:

```bash
bash .omp/skills/cut-release/scripts/preflight.sh
```

**What it verifies:**

| Step | Command | What it verifies |
|------|---------|-----------------|
| 1 | `bun run typecheck` | TypeScript compiles cleanly |
| 2 | `bun run build:extension` | Extension bundles build |
| 3 | `bun test` | In-process Bun tests |
| 4 | `bun run test:pike` | Pike runtime tests |
| 5 | `bun run test:harness` | Harness tests |
| 6 | `bun run test:e2e` | E2E tests (VSCode extension host) |

Steps run in order, **failing fast** on the first error. The release **MUST NOT** proceed if any step fails.


To skip the E2E suite (slow), use `--skip-e2e`:

```bash
bash .omp/skills/cut-release/scripts/preflight.sh --skip-e2e
```

Use this when `@vscode/test-electron` is not installed. CI does not run e2e tests.


---

## Phase 2: Execute Release (`scripts/release.sh` does this)

Run the automation script with the version bump:

```bash
bash scripts/release.sh <OLD_VERSION> <NEW_VERSION>
```

**Example:**
```bash
bash scripts/release.sh 0.3.4-beta 0.3.4-beta
```

### What the script does

1. **Pre-flight**: Verifies OLD_VERSION exists in all 9 version manifest files. Aborts if any are missing (prevents wrong version being passed).

2. **Update files**: Replaces version in all manifest files:
   | File | Pattern |
   |------|---------|
   | `.template-version` | whole file content |
   | `CHANGELOG.md` | Creates new version section from Unreleased |
   | `AGENTS.md` | `version **X.Y.Z**` |
   | `README.md` | `template-vX.Y.Z` in badge |
   | `.omp/skills/template-guide/SKILL.md` | `template-version: X.Y.Z` |
   | `.omp/skills/template-guide/scripts/audit.sh` | `TEMPLATE_VERSION=X.Y.Z` |
   | `extension.package.json` | `"version": "X.Y.Z"` |
   | `package.json` | `"version": "X.Y.Z"` |
   | `.omp/skills/cut-release/SKILL.md` | version in example commands (if present) |

3. **Post-flight**: Verifies NEW_VERSION exists in all files where it should.

4. **Build VSIX**: Packages the VSCode extension via `scripts/build-vsix.sh`.

### Dry run mode

```bash
bash scripts/release.sh <OLD> <NEW> --dry-run
```

Shows what would change without making any modifications.

---

## Phase 3: Commit, PR, Merge, Tag, Release (You do this)

1. **Review changes**:
   ```bash
   git diff
   ```

2. **Commit**:
   ```bash
   git add -A
   git commit -m "chore: cut vX.Y.Z"
   ```

3. **Push branch**:
   ```bash
   git push -u origin HEAD
   ```

4. **Create PR** (or use `merge-to-main` skill):
   ```bash
   gh pr create --base main --title "chore: cut vX.Y.Z" --body "## Summary

   Cut release vX.Y.Z.

   ## Changes

   - Updated version references across all manifest files
   - CHANGELOG.md updated with release section
   - VSIX rebuilt and included in artifacts

   ## Verification

   - All 9 manifest files updated with new version
   - VSIX build succeeded
   - No stale version references remain"
   ```

5. **Monitor CI and merge** when all checks pass:
   ```bash
   gh pr merge <pr-number> --squash
   ```

6. **Switch to main and pull**:
   ```bash
   git checkout main && git pull
   ```

7. **Create annotated tag**:
   ```bash
   git tag -a vX.Y.Z -m "Release vX.Y.Z"
   ```

8. **Push tag**:
   ```bash
   git push origin vX.Y.Z
   ```

9. **Create GitHub release**:
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file CHANGELOG.md
   ```

   The release body is the changelog section for this version (everything between `## [X.Y.Z]` and the next `## [` or end of file). Using `--notes-file CHANGELOG.md` with the correct tag creates this automatically.

---

## Phase 4: Verify

1. **Release exists and is not draft**:
   ```bash
   gh release list
   gh release view vX.Y.Z
   ```

2. **VSIX asset is attached**:
   ```bash
   gh release view vX.Y.Z --json assets --jq '.assets'
   ```

3. **All manifest files contain the new version**:
   ```bash
   cat .template-version          # should show new version
   grep '"version"' package.json  # should show new version
   grep '"version"' extension.package.json  # should show new version
   ```

4. **No stale references to old version remain**:
   ```bash
   grep -rn "vOLD-VERSION" . --include='*.md' --include='*.json' --include='*.sh' --exclude-dir=.git  # must be empty
   ```

---

## Edge Cases

| Situation | Handling |
|-----------|----------|
| Empty `[Unreleased]` section | Abort — nothing to release |
| Multiple version-like strings | Use anchored patterns (handled by script) |
| Tag already exists | Detect via `git tag -l vX.Y.Z` and abort |
| Wrong version passed | Pre-flight check catches missing OLD_VERSION |
| Pre-flight checks fail | Abort — fix failures before releasing |
| VSIX build fails | Script aborts; fix build errors before committing |

---

## What This Skill Does NOT Do

- Does not write the code or features being released
- Does not force-push or rewrite shared history
- Does not auto-resolve merge conflicts
- Does not bypass branch protection or skip CI checks
- Does not upload to the VS Code Marketplace (manual step after GitHub release)