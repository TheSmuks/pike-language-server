---
name: pmp-guide
description: Use pmp for Pike module resolution, dependency management, and script execution
category: reference
tags: [pike, pmp, module-resolution, dependencies, runtime]
version: 1.0.0
mu|
md|
# pmp Guide

`pmp` is the Pike module package manager. Use it instead of raw `pike -M` for running scripts that depend on project modules.

## When to Use pmp

| Situation | Command |
|---------|---------|
| Running a Pike script with project modules | `pmp run <script> [args]` |
| Installing Pike dependencies | `pmp install` |
| CI / automated test runs | `bun run test:pike` (wraps `pmp run`) |

**Use `pmp run`** instead of `pike -M modules -M harness ... <script>`.

## Why pmp

- `pmp` reads module path configuration automatically — no need to chain `-M` flags
- `pmp install` fetches and links Pike dependencies (like `npm install`)
- CI installs `pmp` v0.5.0 to `~/.pmp/bin/pmp` and adds it to `PATH`
- `pmp run` sets up module paths correctly for the full test suite

## When to Use Raw pike

- **One-liners** via `pike -e 'code'`
- **Scripts with no external module dependencies**
- **Debugging module resolution** — raw `pike -M module -M harness` for manual troubleshooting

## Key Commands

```bash
# Run a Pike script with automatic module resolution
pmp run tests/pike/run_tests.pike tests/pike

# Install Pike dependencies (run once before tests)
pmp install

# Via npm (what CI uses)
bun run test:pike
```

## Module Resolution Order

`pmp` resolves modules from:
1. Local `pike.json` / `pmp.json` project configuration
2. `~/.pike/modules/` user-level modules
3. Pike standard library

## CI Pipeline

CI runs `pmp install` then `pmp run tests/pike/run_tests.pike tests/pike`. Do not use raw `pike -M modules -M harness` in CI — use `bun run test:pike`.
