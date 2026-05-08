# Contributing

Thank you for your interest in contributing. This document covers the conventions used in this project.

## Quick Start

1. Fork the repository
2. Create a feature branch (see [Branch Naming](#branch-naming))
3. Make your changes
4. Update [CHANGELOG.md](./CHANGELOG.md) under `[Unreleased]`
5. Open a Pull Request

## Branch Naming

Follow [Conventional Branch](https://github.com/nickshanks347/conventional-branch) naming:

```
<type>/<short-description>
```

| Type | Use for |
|------|----------|
| `feature/`, `feat/` | New functionality |
| `bugfix/`, `fix/` | Bug fixes |
| `hotfix/` | Urgent production fixes |
| `chore/` | Maintenance, deps, tooling |
| `docs/` | Documentation only |
| `refactor/` | Code restructuring without behavior change |
| `perf/` | Performance improvements |
| `test/` | Adding or updating tests |
| `ci/` | CI/CD pipeline changes |
| `release/` | Release preparation |

Rules:

- Lowercase only
- Use hyphens (not underscores) to separate words
- Keep descriptions short and descriptive

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

**Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`

**Examples:**

```
feat: add embedding generation pipeline
fix(api): handle rate limit errors gracefully
docs: update README with setup instructions
chore(deps): bump transformers to 4.40.0
```

### Breaking Changes

Include `BREAKING CHANGE:` in the footer or add `!` after the type:

```
feat!: redesign model configuration API

BREAKING CHANGE: ModelConfig now requires a `provider` field.
```

## Changelog

Update [CHANGELOG.md](./CHANGELOG.md) under the `[Unreleased]` section for every user-facing change. Use the appropriate subsection:

- **Added**: New features
- **Changed**: Changes to existing functionality
- **Deprecated**: Features to be removed in future releases
- **Removed**: Removed features
- **Fixed**: Bug fixes
- **Security**: Vulnerability fixes

## Pull Requests

- Keep PRs focused on a single concern
- Include tests for new behavior
- Ensure CI passes
- Reference related issues in the PR description
- Follow the PR template when opening a PR

## AI Agent Scaffolding

This project uses AI agent skills stored in `.omp/skills/`. Each skill is a self-contained Markdown file documenting a specific task domain.

### Available Skills

| Skill | Purpose |
|-------|---------|
| `pike-introspection/` | Pike runtime introspection, parser, and stdlib APIs |
| `pike-language-reference/` | Pike language syntax, semantics, and type system |
| `pike-stdlib-api/` | Pike 8.0.1116 standard library API surface |
| `pike-debugging/` | Debugging Pike code, introspecting the runtime |
| `cut-release/` | Cutting a clean release (version bump, changelog, VSIX) |
| `merge-to-main/` | Automating the PR lifecycle (create, monitor, merge) |
| `setup/` | Interactive project setup workflow |

### Using Skills

AI agents automatically discover skills via the `.omp/skills/` directory. When an agent asks about Pike APIs, syntax, or debugging, it should consult the relevant skill first.

### Contributing Skills

New skills should be added to `.omp/skills/<name>/SKILL.md`. Each skill must document:
- What problem it solves
- Key APIs and patterns
- Common pitfalls and edge cases
