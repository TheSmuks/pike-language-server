# Project Context

This file is auto-discovered by AI coding agents. It provides project-level context that guides agent behavior.

## Project Overview

- **Name**: Pike Language Server
- **Description**: Tier-3 LSP implementation for Pike, using pike as oracle for semantic information and tree-sitter-pike as syntactic parser. VSCode as primary client.
- **Primary Language**: TypeScript 5.x, Node.js 22+

## Build & Run

```bash
# Install dependencies
bun install

# Build
bun run build

# Run tests
bun test

# Lint
bun run lint

# Type check
bun run typecheck
```

## Code Style

- Follow the existing patterns in the codebase
- Write descriptive commit messages (see CONTRIBUTING.md)
- Keep functions small and focused
- Add tests for new behavior
- Update CHANGELOG.md for user-facing changes
- Pike code in corpus files should be verified against pike-ai-kb before writing

### Module and File Size Guidelines

| Metric | Guideline | Action if exceeded |
|--------|-----------|-------------------|
| File length | 500 lines | Split into focused modules |
| Function/method length | 50 lines | Extract helpers |
| Module exports | 20 public symbols | Re-evaluate module boundary |
| Nesting depth | 4 levels | Flatten with early returns or extract |

## Project Structure

```
server/           # LSP server (TypeScript, vscode-languageserver-node)
extension/        # VSCode extension that hosts the LSP server
harness/          # Test harness — invokes pike, captures ground truth, compares LSP output
corpus/           # Pike files covering language features the LSP must handle
  files/          # Actual Pike source files
  manifest.md     # Inventory of files and what features each exercises
docs/             # Investigation results, interface documentation
  decisions/      # Architecture Decision Records
decisions/        # Root-level decision documents
```

## Testing

- All new features must include tests
- Bug fixes must include regression tests
- Run the full test suite before submitting a PR
- Tests must be deterministic: no reliance on external services, wall-clock time, or random state unless explicitly controlled
- Test expected output must come from `pike`, not from hand-written expectations (canary tests are the sole exception)
- Prefer integration tests over mocks — mocks invent behaviors that never happen in production

## Error Handling

- **Do not suppress errors.** Catching an exception and continuing silently is a bug.
- **Errors must be distinguishable from success.** A function that returns plausible-looking output when it has failed has broken its contract with every caller.
- **Fail at the boundary.** Validate inputs at system edges (user input, network responses, file I/O). Trust internal code.
- **Wrap, don't expose.** When wrapping an error from a dependency, add context.
- **No lying.** If an operation partially fails, do not return a success result with some fields silently missing. Return an error or a structured result that preserves the truth.

## CI/CD

CI uses separate workflow files, one concern per file. See [docs/ci.md](./docs/ci.md) for the full guide.

| Workflow | Purpose |
|----------|---------|
| `ci.yml` | Lint, typecheck, test — project-specific jobs |
| `commit-lint.yml` | Conventional commit enforcement |
| `changelog-check.yml` | Changelog update enforcement (PRs only) |
| `blob-size-policy.yml` | Rejects oversized files (PRs only) |

## Agent Behavior

When an AI agent is working in this repository:

1. **Always create PRs for changes.** Do not push directly to `main`.
2. **Run available validation before requesting review.** Execute lint, type-check, and test commands before declaring work complete.
3. **Read before editing.** Read the full file or section before making changes.
4. **Check references before renaming.** Use `grep` or language-server tools to find every consumer of a symbol before changing it.
5. **One concern per change.** A PR should address one issue or feature. Do not bundle unrelated refactors.
6. **Update documentation in the same change.** If code behavior changes, update comments, doc strings, and relevant docs in the same commit.
7. **Preserve invariants.** If the codebase has patterns, follow them. Do not introduce a new pattern without removing the old one.
8. **Clean up after yourself.** Remove unused imports, dead code, and temporary files.


## Operating Principles

1. **Tests are ground truth.** Pike is the oracle. pike-ai-kb is the interface to the oracle. Every test derives expected output from pike.
2. **No phase begins until the previous phase is 100% complete.** "Mostly working" is not done.
3. **Specific failures, not category labels.** Describe failures precisely: input X produces output Y at position Z, when it should produce W.
4. **The test harness can be wrong.** Audit it. Canary tests catch harness bugs.
5. **Decisions go in decisions/.** Write the decision document before committing.
6. **Check pike-ai-kb before generating Pike code.** The knowledge base is runtime-verified; agent priors on Pike are unreliable.
7. **Consult docs/lsp-references.md before designing an LSP architectural pattern.** Other LSPs have solved most hard problems; understand their solutions before inventing your own.

## Conventions

### Commits

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`

### Branches

Follow [Conventional Branch](https://github.com/nickshanks347/conventional-branch) naming:

```
<type>/<short-description>
```

### Changelog

Follow [Keep a Changelog](https://keepachangelog.com/). Update `CHANGELOG.md` under `[Unreleased]` for every user-facing change.

## Template Version

This project was generated from `ai-project-template` version **0.2.0**. See [`.template-version`](./.template-version) for the current release.
