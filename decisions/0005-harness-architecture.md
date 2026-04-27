# Decision 0005: Harness Architecture

**Date:** 2026-04-26
**Status:** Accepted
**Context:** Phase 1 — test harness scaffolding

## Decision

The harness is a two-layer system: a Pike script that produces structured JSON from compilation, and a TypeScript test runner that invokes it, captures snapshots, and verifies them.

## Architecture

```
harness/
  introspect.pike        # Pike script: compile + capture diagnostics + AutoDoc → JSON
  src/
    runner.ts            # Orchestrator: run introspect.pike on corpus, capture output
    snapshot.ts          # Snapshot read/write/diff
    canary.ts            # Canary test definitions
  snapshots/             # Ground-truth JSON files, one per corpus file
    basic-types.json
    err-type-assign.json
    ...
  __tests__/
    harness.test.ts      # Main test: all corpus files have snapshots, zero diffs
    canary.test.ts       # Canary tests: hand-verified expectations
```

### Layer 1: Pike Introspection Script (`introspect.pike`)

A single Pike script that:
1. Takes a Pike source file path as argument
2. Reads the source
3. Compiles with `compile_string` using a custom `CompilationHandler` to capture diagnostics
4. Runs `extract_autodoc` on the file to capture type information (best-effort)
5. Emits a single JSON object to stdout

**Output schema:**
```json
{
  "file": "path/to/file.pike",
  "pike_version": "8.0.1116",
  "timestamp": "2026-04-26T12:00:00Z",
  "diagnostics": [
    {
      "line": 5,
      "severity": "error",
      "message": "Bad type in assignment.",
      "expected_type": "int",
      "actual_type": "string(32..116)"
    }
  ],
  "autodoc": "<xml>...</xml>" | null,
  "exit_code": 0 | 1,
  "stdout": "...",
  "stderr": "..."
}
```

**Invocation:** `pike introspect.pike [--strict] [--module-path <path>] <file.pike>`

- `--strict`: prepend `#pragma strict_types` to the source before compilation (only if not already present)
- `--module-path <path>`: add to `-M` module path for cross-file resolution
- The script always emits JSON to stdout, even on compilation failure
- stderr is captured separately (for any Pike runtime errors in the introspection script itself)

### Strict vs Non-Strict Mode

The harness handles both strict and non-strict compilation:

- **Strict files** (e.g., `basic-types.pike`): contain `#pragma strict_types` in their source. The `--strict` flag is a no-op for these files because the pragma is already present. The runner defaults to `strict: false` — the pragma in the source drives the behavior.
- **Non-strict files** (e.g., `basic-nonstrict.pike`): do not contain `#pragma strict_types`. Without the flag, Pike compiles in lenient mode where type errors are silently accepted and unused-variable warnings are suppressed.

The runner's `getRunnerOptionsForFile` defaults to `strict: false`. Files that need strict mode must declare `#pragma strict_types` in their source. This ensures the snapshot metadata (`compilation.strict_types`) accurately reflects what the runner requested, not what the source contains.

Behavioral difference verified: `basic-nonstrict.pike` produces 5 diagnostics without strict mode vs 9 with strict mode (the strict version adds 4 "Unused local variable" warnings).

### Layer 2: TypeScript Test Runner

Uses `bun test`. Two test files:

#### `harness/__tests__/harness.test.ts`

For each corpus file:
1. Run `pike introspect.pike --strict <file>`
2. Parse the JSON output
3. Compare against the snapshot in `harness/snapshots/<name>.json`
4. Report any diffs

Test cases:
- "every corpus file has a snapshot" — enumerate corpus files, verify snapshot exists
- "snapshot matches ground truth" — run introspect, compare to snapshot, zero diffs
- "two consecutive runs produce identical output" — determinism check
- "modifying a corpus file produces a diff" — mutation test
- "all snapshots have valid schema" — structural validation

#### `harness/__tests__/canary.test.ts`

5-10 hand-verified tests that check specific known behaviors:
1. `basic-types.pike` produces zero diagnostics (no errors)
2. `err-type-assign.pike` produces exactly the expected error messages at expected lines
3. `err-undef-var.pike` produces "Undefined identifier" diagnostics
4. `err-arity-few.pike` produces "Too few arguments" diagnostics
5. `err-syntax-basic.pike` produces syntax error diagnostics
6. A deliberately broken pike file produces at least one diagnostic
7. A file with `#pragma strict_types` has type-checked diagnostics
8. AutoDoc extraction produces XML for files with `//!` comments
9. The introspection script itself produces valid JSON for every corpus file
10. `pike_version` in the output matches the installed pike version

These are the ONLY tests with hand-written expectations. They serve as harness integrity checks.

### Snapshot Format

Snapshots are JSON files stored in `harness/snapshots/`. They are the authoritative ground truth for what pike produces. The snapshot comparison is structural (JSON deep equality), not textual.

Snapshot fields are normalized to avoid false positives from non-deterministic data:
- `timestamp` is excluded from comparison
- `stdout` is excluded from comparison (may contain runtime output like timestamps)
- `stderr` is excluded from comparison (introspection script noise)
- Only `diagnostics`, `autodoc`, `exit_code`, `file` are compared

### Error Message Parsing

The CompilationHandler captures raw messages. The harness normalizes them:
- "Bad type in assignment." → severity: error, category: type_mismatch
- "Expected: <type>." → extract expected_type
- "Got     : <type>." → extract actual_type
- "Undefined identifier <name>." → severity: error, category: undefined_identifier, symbol: name
- "Too few arguments to <fn> (got <n>)." → severity: error, category: wrong_arity
- "Too many arguments to <fn> (expected <n> arguments)." → severity: error, category: wrong_arity
- "Warning: <msg>" → severity: warning
- "syntax error" → severity: error, category: syntax_error

### What the Harness Measures

The harness captures **what pike says about a file**. It does NOT measure:
- What the LSP server produces (that's Phase 2+)
- Whether pike is correct (pike IS the oracle)
- Performance or latency

What Phase 1's harness provides:
1. A reproducible ground-truth baseline for all 35 corpus files
2. A way to detect when pike's output changes (version upgrade, environment change)
3. Canary tests that verify the harness itself isn't broken
4. A framework that Phase 2+ can extend to compare LSP output against ground truth

## Consequences

- The harness is the first TypeScript code in the project. `package.json`, `tsconfig.json`, and `bun` setup are Phase 1 prerequisites.
- Snapshots are committed to git. They are test artifacts, not generated files.
- The Pike introspection script is a critical piece of infrastructure — bugs in it propagate to all downstream tests.
- Canaries are the safety net for the harness. If canaries fail, the harness itself is broken, not pike.

## Deferred Items

### Cross-file invocation: manifest-driven metadata (Phase 4 prerequisite)

Phase 1 special-cases cross-file invocation by filename (`CROSS_FILE_FLAGS` in `runner.ts`). Two files need custom flags:
- `cross-lib-consumer.pike` → `includePath: "."`
- `cross-lib-user.pike` → `modulePath: "."`

This approach does not scale. Phase 4's corpus will have significantly more cross-file tests, and the filename-based detection will multiply into unmaintainable special cases.

**Phase 4 entry checkpoint requirement:** Replace `CROSS_FILE_FLAGS` with per-file metadata from `corpus/manifest.md` (or a separate `corpus/corpus.json` config file). Each corpus entry that requires cross-file flags must declare them in the manifest. The runner reads this metadata instead of hardcoding filenames.

This work must be complete before Phase 4 entry is approved.