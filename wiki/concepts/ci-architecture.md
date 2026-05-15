---
title: CI Architecture
created: 2026-05-15
updated: 2026-05-15
type: concept
tags:
  - ci
  - deployment
sources:
  - raw/articles/ci.md
---

# CI Architecture

GitHub Actions CI pipeline for the Pike Language Server, organized as five independent workflow files.

- [[deployment-context]]
- [[pike-worker]]

## Workflow Files

| Workflow | Purpose | Trigger |
|----------|---------|---------|
| `ci.yml` | Lint, typecheck, and test | Push to main, PRs to main |
| `commit-lint.yml` | Enforce conventional commit messages | Push to main, PRs to main |
| `changelog-check.yml` | Require changelog entries on PRs | PRs to main |
| `blob-size-policy.yml` | Reject large files in PRs | PRs to main |
| `branch-cleanup.yml` | Delete merged feature branches | PR closed |

## Design Principles

Each workflow owns a single responsibility:

- **Independently disableable** -- A failing commit-lint rule does not block test runs. Disable from the GitHub UI without editing YAML.
- **Overridable** -- Teams can replace `ci.yml` with their own while keeping policy workflows intact.
- **Cacheable** -- Each workflow maintains its own run history and cache scope, avoiding cross-contamination.

Every workflow declares:

```yaml
permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

- **`permissions`** -- Least-privilege default. `branch-cleanup.yml` needs `contents: write` and declares only that permission.
- **`concurrency`** -- Cancels superseded runs for the same branch or PR, reducing queue time.

## Pike Build from Source

The test job depends on a `build-pike` job that compiles **Pike 8.0.1116** from the official source tarball. This ensures CI runs against the same Pike version used locally.

Build steps:
1. Download `Pike-v8.0.1116.tar.gz` from `pike.lysator.liu.se` (16MB)
2. Configure with `--without-debug --without-mysql` (minimal release build)
3. `make -j$(nproc) && make install` into the workspace
4. Cache the install prefix (e.g., `.pike/pike/8.0.1116/`)

The build is cached with `actions/cache` keyed on `pike-8.0.1116-$RUNNER_OS`. Since the version is pinned, the cache always hits after the first build on a given runner image (~52MB install prefix restored in seconds).

The test job sets `PIKE_BINARY` to the cached binary path. No system-wide `pike8.0` apt package is needed.

## Caching Strategies

### Bun

`setup-bun` installs Bun and restores `~/.bun/install/cache` keyed on `bun.lockb`. `bun install --frozen-lockfile` fails if the lockfile is out of date.

### Python

`actions/setup-python` caches pip's download directory keyed on `requirements.txt`.

### Go

`actions/setup-go` caches `~/go/pkg/mod` and the build cache automatically. No extra configuration required.

### Rust

No official setup action with built-in caching, so `actions/cache` is used directly. Key includes OS and hash of `Cargo.lock`. `restore-keys` prefix fallback avoids cold cache when only `Cargo.lock` changed.

## Parallelization

Jobs run in parallel by default. Use `needs` to create a dependency graph:

```yaml
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - run: bun run typecheck

  test:
    needs: [lint]
    runs-on: ubuntu-latest
    steps:
      - run: bun test
```

`lint` runs first. `test` starts only after `lint` succeeds. Matrix builds available for multi-version testing.

## Performance Tips

- **Cancel superseded runs** -- `concurrency` group cancels older in-progress runs for the same ref
- **Skip CI** -- Include `[skip ci]` or `[ci skip]` in commit messages for docs-only changes
- **Shallow clones** -- Default `fetch-depth: 1` is sufficient for most jobs. Use `fetch-depth: 0` only for commit-lint
- **Cache aggressively** -- Specific cache keys maximize hit rates; prefix fallback handles lockfile changes
