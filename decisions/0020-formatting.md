# Decision 0020: Source Code Formatting (Phase 16)

**Date:** 2026-05-02

**Status:** In Progress (WIP — upstream pike-fmt not yet published)

**Updated:** 2026-05-04 — Architecture revised to standalone tool (pike-fmt)

## Context

The project has implemented all core Tier-3 LSP features through Phase 15 (documentSymbol, definition, references, hover, diagnostics, completion, rename, semantic tokens, document highlight, folding range, signature help, code actions, workspace symbol). Formatting (`textDocument/formatting`) is the next feature to implement.

Pike source code formatting requirements:
- **2-space indentation** (Pike stdlib convention)
- **Opening brace on same line** as declaration (`class Foo {`, `void create() {`)
- **No space before `(`** in function declarations/calls
- **Space after `//` and `//!`** in comments

## Decision

Implement `textDocument/formatting` using a **three-layer architecture**:

```
Component 1: language-configuration.json  (client-side, zero LSP traffic)
Component 2: pike-fmt                      (standalone formatter tool)
Component 3: LSP formatting handler         (thin wrapper, calls pike-fmt)
```

### Why not in-LSP formatting

Mature LSPs do not implement formatting in the server:

- **gopls**: Does not implement formatting. Shells out to `go fmt`.
- **rust-analyzer**: Does not implement formatting. Shells out to `rustfmt`.

The LSP is a thin wrapper. The formatter is an independent tool with its own release cycle, test suite, and CLI interface. This allows:
- Formatter can be used outside the LSP (CI, pre-commit hooks, CLI)
- Separate versioning and release cycle
- LSP handler is ~50 lines: spawn process, pipe stdin, collect stdout, diff→TextEdit[]

### Component 1: `language-configuration.json` (DONE)

Client-side VS Code indentation rules. Handles:
- `indentationRules`: regex-based increase/decrease indent for `{`, `}`, `(`, `)`, Pike literals `({`, `([`, `(<`
- `onEnterRules`: special Enter behavior after `case`, `default`, and `//` comments
- No LSP traffic, no subprocess, immediate response

File: `client/language-configuration.json`

### Component 2: `pike-fmt` (WIP)

**Repository**: `/tank/appdata/pike-dev/projects/pike-fmt/` (local, not yet published)

Standalone formatter tool using tree-sitter-pike WASM.

**Architecture**: Tree-sitter AST walker with formatting rules.

Phase 1 scope:
- Normalize leading indentation (2-space, configurable)
- Normalize trailing whitespace
- Insert final newline (configurable)
- Preserve all non-whitespace content — no structural changes

**Status**: WIP. Phase 1 structure exists but not yet published as npm package.

**Why not Topiary**: Topiary uses tree-sitter queries declaratively (`.scm` files). Rejected — adds Rust binary dependency. Decision 0020 already rejected this.

**Repository structure**:
```
pike-fmt/
  src/
    formatter.ts       # Tree-walking formatter (shared with LSP)
    cli.ts             # CLI entry point
  tests/
    formatter.test.ts  # Unit tests + idempotency verification
  package.json
```

**CLI interface**:
- `pike-fmt [options] <file>` or stdin
- Exit code 0 = formatted, 1 = error, 2 = invalid args
- `--tab-size`, `--use-tabs`, `--no-final-newline`

### Component 3: LSP formatting handler (DONE)

Thin wrapper that shells out to `pike-fmt`.

When the LSP receives `textDocument/formatting`:
1. Get document text
2. Spawn `pike-fmt` subprocess with formatting options as CLI args
3. Collect formatted output from stdout
4. Diff original vs formatted → produce `TextEdit[]`
5. Return edits

If `pike-fmt` is not installed, returns an error response (not silent failure).

File: `server/src/features/formattingHandler.ts` (~50 lines)

### What we did NOT do

- **No `textDocument/onTypeFormatting`**. Live editing handled by `language-configuration.json`. On-type formatting creates conflicting edit authorities — well-known failure mode.
- **No extension-host formatting loop**. Would create race conditions with editor auto-indent.
- **No formatting logic in the LSP**. LSP calls external tool, like gopls calls `go fmt`.
- **No pretty-printing in Phase 1**. Indentation normalization only.

### Pike stdlib formatting conventions

From corpus analysis and stdlib examination:
- 2-space indentation
- Opening brace on same line (`class Foo {`, `void create() {`)
- No space before `(` in function declarations/calls
- Space after `//` and `//!` in comments

## Implementation Phases

**Phase A: `language-configuration.json`** ✅ DONE
- Add to `client/` and register in extension activation
- Cover: braces, Pike literals, switch/case/default, comment continuation

**Phase B: Standalone formatter** (`pike-fmt`) 🔄 WIP (structure + Phase 1, not published)
- Tree-walking formatter using tree-sitter-pike
- CLI interface: `pike-fmt [options] <file>` or stdin
- Phase 1 scope: indentation normalization only
- Own test suite with idempotency verification
- **TODO**: Publish to npm, add CI integration

**Phase C: LSP integration** ✅ DONE
- `formattingHandler.ts` — spawn `pike-fmt`, diff, return TextEdit[]
- Register formatting capability in `server.ts`

**Phase D: Tests and corpus verification** (TODO)
- Run formatter against all corpus files
- Verify idempotency (format twice = same output)
- Verify formatted output parses correctly with tree-sitter

## Follow-up Actions

- [ ] Add formatting tests to `tests/lsp/formatting.test.ts`
- [ ] Test against corpus files to verify formatting rules
- [x] Document formatting behavior in docs/known-limitations.md
- [x] Create pike-fmt repository with Phase 1 implementation
- [ ] Publish pike-fmt to npm
- [ ] Verify idempotency with corpus files
- [ ] Add CI integration for pike-fmt