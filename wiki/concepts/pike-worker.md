---
title: PikeWorker
created: 2026-05-15
updated: 2026-05-15
type: concept
tags:
  - architecture
  - component
  - performance
sources:
  - raw/articles/architecture.md
  - raw/articles/deployment-context.md
---

# PikeWorker

PikeWorker is the component that manages the Pike compiler subprocess. It is the
bridge between the language server's TypeScript codebase and the Pike runtime's
semantic capabilities: compilation, type evaluation, and symbol introspection.

## Responsibilities

PikeWorker provides three primary operations:

| Operation | Method | Description |
|-----------|--------|-------------|
| Compilation | `compile()` / diagnostics | Compiles source via `compile_string` with `CompilationHandler`, returns structured diagnostics |
| Typeof | `typeof_(source, expression)` | Evaluates `typeof()` in the Pike runtime for a given expression in context |
| Describe | `autodoc()` | Extracts AutoDoc XML from a file for hover documentation |

## Lifecycle Management

### Idle Eviction

The Pike subprocess is killed after **5 minutes of no requests** (`idleTimeoutMs:
300000`). On the shared server (see [[deployment-context]]), idle workers consume
memory that compounds across N users × M open windows. Eviction prevents
unbounded memory growth.

### Forced Restart

| Trigger | Default | Rationale |
|---------|---------|-----------|
| `maxRequestsBeforeRestart` | 100 | Prevents memory leaks in long-running Pike processes |
| `maxActiveMinutes` | 30 | Caps total subprocess lifetime |
| `requestTimeoutMs` | 5000 (5s) | Per-request timeout; surfaced as diagnostic rather than silently dropped |

### SIGKILL Escalation

If the Pike subprocess does not respond to SIGTERM within the timeout window,
the worker escalates to SIGKILL. This ensures zombie processes do not accumulate.

## Priority Queue

Requests to the Pike worker are queued with priority. Diagnostics from the slow
layer (see [[two-speed-diagnostics]]) are lower priority than interactive
requests (hover typeof queries). This prevents compilation queues from blocking
user interactions.

## Cache Limits

| Constant | Default | Purpose |
|----------|---------|---------|
| `CACHE_MAX_ENTRIES` | 50 | Max cached files per server instance |
| `CACHE_MAX_BYTES` | 25 MB | Max total cache memory per server instance |

## Subprocess Configuration

The Pike subprocess runs with `nice +5` to reduce CPU contention on the shared
server. Include paths, module paths, and preprocessor defines from the project
configuration are forwarded to the subprocess.

## Critical Concern: Zombie Processes

On a shared server with multiple developers, **zombie Pike subprocesses are a
critical failure mode**. Each VSCode window creates a separate LSP server
instance, each potentially spawning a Pike worker. If the LSP server crashes or
is killed without cleanup, the Pike subprocess becomes orphaned. The worker
implements:

1. SIGTERM on idle timeout
2. SIGKILL escalation after grace period
3. Process tracking via PID
4. `maxRequestsBeforeRestart` to prevent runaway processes

## Warm-Up

The worker supports a `warmUp()` method called during initialization to
pre-start the subprocess. This avoids the cold-start latency (~150ms) on the
first real request.

## Related

- [[pike]] — the language runtime managed by PikeWorker
- [[deployment-context]] — shared server constraints driving the design
- [[two-speed-diagnostics]] — the slow diagnostic layer that consumes PikeWorker
