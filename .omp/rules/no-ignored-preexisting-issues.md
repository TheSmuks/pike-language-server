# Rule: No Ignored Pre-Existing Issues

## Scope

All file edits, test files, and documentation changes.

## Rule

When a pre-existing issue is discovered during work, agents **MUST NOT** silently ignore it.

### Required actions upon discovery

1. **File it** — create a GitHub issue, add a `TODO` comment with a linked upstream URL, or create a known-limitations entry. Do not silently pass by.
2. **If within scope of current task** — fix it as part of the current work.
3. **If out of scope** — document it explicitly in the relevant `docs/known-limitations.md`, comment, or issue, and state why it is deferred.

### Triggers

- `test.skip(...)` or `test.skipIf(...)` for a test that is not an intentional design constraint
- Commented-out tests
- Workarounds with upstream issue links (e.g. `// TODO: remove workaround once upstream bug X is fixed`)
- `// TODO`, `// FIXME`, `// HACK`, or `// NOTE` comments that reference a known defect
- Test failures (SKIP, FAIL, ERROR) in the test output
- Known limitations documented in `docs/known-limitations.md`

### Rationale

This rule is derived from the project's safety-first principles (AGENTS.md):

> "We do not defer known defects."

> "Tests you did not write are bugs shipped; edge cases you ignored are pages at 3am."

In high-reliability domains (defense, finance, healthcare, infrastructure), bugs have material impact on human lives. Suppressing known failures — even temporarily — creates latent defects that compound over time.

### Examples

**Correct:**
```typescript
// Before: silently skipped
test.skip("sigHelp.second-param", () => { ... });

// After: filed with context
test.skip("sigHelp.second-param", () => {
  // SKIP: tree-sitter-pike#123 — class scope not found for constructor lookup.
  // Fixed by using findClassScope() in signatureHelp.ts:resolveSignature().
  // Remove this skip once the fix is verified.
});
```

**Correct:**
```typescript
// Workaround for upstream bug
const result = workaroundHack(); // TODO: remove once pike-lang#456 is resolved (https://github.com/.../issues/456)
```

**Incorrect:**
```typescript
// Suppressed without documentation
test.skip("some-thing", () => { ... }); // "we know this fails but it's fine"
```

**Incorrect:**
```typescript
// TODO without a linked issue
// TODO: fix this
```
