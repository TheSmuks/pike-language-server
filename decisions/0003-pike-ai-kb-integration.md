# Decision 0003: pike-ai-kb Integration Strategy

**Date:** 2026-04-26
**Status:** Accepted
**Context:** Phase 0 investigation — how to interface with pike

## Decision

Use pike-ai-kb's MCP tools for all operations they cover. Fall back to direct `pike` subprocess invocation for operations pike-ai-kb does not cover. Design the system so that pike-ai-kb unavailability degrades gracefully to direct invocation for supported operations.

## Where pike-ai-kb Is Used

| LSP Feature | pike-ai-kb Tool | Why |
|-------------|----------------|-----|
| Diagnostics | `pike-check-syntax` | Handles invocation, output parsing, error normalization |
| Hover (stdlib) | `pike-signature`, `pike-describe-symbol` | Provides exact type signatures for stdlib symbols |
| Hover (expressions) | `pike-evaluate` with `typeof()` | Returns runtime type of expressions |
| Completion (stdlib modules) | `pike-list-modules` | Lists all installed Pike modules |
| Completion (stdlib methods) | `pike-list-methods` | Lists methods for a class/module |
| Completion (signatures) | `pike-signature` | Exact type signatures for completion detail |
| Code validation | `pike-validate-example` | Compile + optional run for verification |

## Where Direct Pike Invocation Is Needed

| Operation | Command | Why pike-ai-kb doesn't cover it |
|-----------|---------|-------------------------------|
| Full-file diagnostics | `pike file.pike 2>&1` | `pike-check-syntax` may not handle multi-file projects or complex module paths |
| Project-specific module paths | `pike -M path file.pike` | Need to pass `-I`, `-M`, `-P`, `-D` flags from project config |
| Version-specific compilation | `pike -V 7.8 file.pike` | Respect `#pike` directives per file |
| Stderr capture for error parsing | Direct subprocess | Full control over stderr parsing for the harness |
| Batch diagnostics | Multiple pike invocations | Performance optimization for the harness |

## Fallback Strategy

When pike-ai-kb's MCP server is unavailable at runtime:

1. **Diagnostics:** Fall back to `pike file.pike 2>&1` with the same error format parsing.
2. **Stdlib completion/hover:** Degrade to no data. Stdlib information requires pike-ai-kb or would need a pre-built snapshot.
3. **Type queries:** Fall back to `echo 'typeof(expr);' | pike -x hilfe` (slower, works).
4. **Module listing:** Fall back to `pike -e 'write("%O\n", indices(master()->resolv("")))` or filesystem scanning of module paths.

The LSP server should:
- Detect pike-ai-kb availability at startup
- Log which backend is in use
- Expose the backend status in server capabilities or telemetry
- Never crash due to pike-ai-kb unavailability

## For the Test Harness

The harness always uses direct pike invocation for ground truth:

1. **Ground truth must be reproducible without pike-ai-kb.** The harness captures pike's raw stderr output and normalizes it into structured JSON.
2. **pike-ai-kb's tools wrap pike; they don't change what pike reports.** The same error that `pike file.pike` produces is what `pike-check-syntax` returns.
3. **The harness tests the LSP, not pike-ai-kb.** If pike-ai-kb normalizes an error differently than raw pike, the harness must know about the normalization.

## Implementation Pattern

```typescript
// Conceptual interface
interface PikeOracle {
  checkSyntax(filePath: string, options?: CompileOptions): Promise<Diagnostic[]>;
  getType(expression: string, context?: string): Promise<string | null>;
  listModules(): Promise<string[]>;
  listMethods(modulePath: string): Promise<MethodSignature[]>;
  getSignature(symbolPath: string): Promise<TypeSignature | null>;
}

// MCP-backed implementation (primary)
class McpPikeOracle implements PikeOracle { ... }

// Direct invocation fallback
class DirectPikeOracle implements PikeOracle { ... }

// Factory selects based on availability
function createOracle(): PikeOracle {
  return mcpAvailable ? new McpPikeOracle() : new DirectPikeOracle();
}
```

## Consequences

- The oracle interface is abstracted; the LSP server code never directly calls pike or pike-ai-kb.
- Both backends must produce identical normalized output for the same input.
- The harness uses direct invocation exclusively (no pike-ai-kb dependency for testing).
- Pike-ai-kb unavailability is a degraded mode, not a failure.
- If pike-ai-kb adds new tools, the MCP-backed oracle gains features without server code changes.
