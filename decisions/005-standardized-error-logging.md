# Standardized Error Reporting — Architecture Decision

## Status

Accepted.

## Context

The Pike Language Server has three distinct error-handling patterns that don't communicate with each other:

1. **`connection.console.error()`** — server-side LSP log, wrapped in defensive `try/catch` (~10 locations)
2. **`console.error()`** — raw stderr from PikeWorker, never routed to LSP output
3. **`console.error()`** in TreeSitterProvider — browser DevTools only, invisible to users

There is no centralized error utility, no stack trace capture, no error categorization, and no client-side notification for unhandled errors. The `charAt` crash from v0.4.0 is a good example: it manifested as a `console.error` in DevTools (tree-sitter provider) and a cryptic VSCode popup, with no structured trace available for diagnosis.

## Decision

Introduce `server/src/util/errorLog.ts` and a client-side error overlay that together provide:

- **Structured error log** — `ErrorLog` singleton capturing: timestamp, category, message, stack, context
- **Five error categories**: `parse`, `diagnostics`, `index`, `worker`, `system`
- **Safe logging wrapper** — `logError(connection, category, ctx, err)` that wraps `connection.console.error()` in the defensive try/catch, eliminating repetition
- **Global process handlers** — `unhandledRejection` and `uncaughtException` in `main.ts` that route to `logError`
- **PikeWorker integration** — `PikeWorker` gains an `onError` callback; all `console.error` calls route through it to the shared `logError`
- **Client-side error command** — `pike.showErrorLog` command registered in the extension that opens a VSCode notification with the error count and a button to reveal the output channel
- **Status bar error count** — error badge `(N errors)` appended to the status bar when errors exist; cleared when output channel is shown

## Implementation

### `server/src/util/errorLog.ts`

```ts
export enum ErrorCategory { Parse = 'parse', Diagnostics = 'diagnostics', Index = 'index', Worker = 'worker', System = 'system' }

export interface ErrorEntry {
  id: number;
  timestamp: string;        // ISO-8601 with ms
  category: ErrorCategory;
  message: string;
  stack: string | undefined;
  context: string;          // human-readable location, e.g. "onDidChangeContent(/proj/main.pike)"
}

export class ErrorLog {
  private entries: ErrorEntry[] = [];
  private nextId = 1;
  private static MAX_ENTRIES = 200;

  push(entry: Omit<ErrorEntry, 'id' | 'timestamp'>): ErrorEntry {
    const full: ErrorEntry = { ...entry, id: this.nextId++, timestamp: new Date().toISOString() };
    this.entries.push(full);
    if (this.entries.length > ErrorLog.MAX_ENTRIES) this.entries.shift();
    return full;
  }

  all(): readonly ErrorEntry[] { return this.entries; }
  count(): number { return this.entries.length; }
  clear() { this.entries = []; }
}

/** Global singleton — installed once in main.ts */
export const errorLog = new ErrorLog();

/**
 * Log an error to both the error log and the LSP connection console.
 * The try/catch wrapper handles the case where the connection is closed during teardown.
 */
export function logError(connection: Connection, category: ErrorCategory, ctx: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  const entry = errorLog.push({ category, message, stack, context: ctx });

  const lines = [
    `[${category.toUpperCase()}] ${ctx}`,
    `  message: ${message}`,
    `  errorId: #${entry.id}`,
  ];
  if (stack) lines.push(`  stack:\n${stack.split('\n').map(l => '    ' + l).join('\n')}`);

  try {
    connection.console.error(lines.join('\n'));
  } catch {
    // Connection may be closed during teardown
  }
}
```

### `server/src/main.ts`

```ts
import { errorLog, logError, ErrorCategory } from './util/errorLog.js';

process.on('uncaughtException', (err: Error) => {
  // @ts-ignore — Connection may not be initialized yet
  logError({ console: { error: (msg: string) => console.error(msg) } } as Connection, ErrorCategory.System, 'uncaughtException', err);
  console.error('uncaughtException:', err.message, err.stack);
});

process.on('unhandledRejection', (reason: unknown) => {
  logError({ console: { error: (msg: string) => console.error(msg) } } as Connection, ErrorCategory.System, 'unhandledRejection', reason);
});
```

### `PikeWorker` updates

```ts
// Add to PikeWorker constructor
this.onError = (category: ErrorCategory, ctx: string, err: unknown) => {
  logError(this.connection, category, ctx, err);
};
```

All `console.error` in PikeWorker replaced with `this.onError?.(ErrorCategory.Worker, ctx, err)`.

### Client-side extension.ts

```ts
// New command
context.subscriptions.push(
  vscode.commands.registerCommand('pike.showErrorLog', () => {
    outputChannel.show(true);
    const count = errorCount; // communicated via protocol from server
    vscode.window.showInformationMessage(
      count > 0 ? `Pike LSP: ${count} error(s) — see output panel` : 'Pike LSP: no errors',
      'Dismiss'
    );
  })
);

// Status bar: show error badge
if (errorCount > 0) {
  statusBarItem.text = `$(warning) Pike LSP (${errorCount} errors)`;
  statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
}
```

The server sends error count to the client via a custom `pike/errorCount` notification.

## Consequences

- **Positive**: All errors are logged with context, category, and stack traces. Errors survive beyond the current stack frame. Users can see error summaries without opening DevTools.
- **Negative**: `logError` needs to be called at every error site — a moderate refactor across ~15 files.
- **Risk**: The defensive `try/catch` wrapper is preserved but now centralized — if `connection.console.error` itself throws (not just the connection being closed), we need to handle that too. Currently falls back to `console.error` which is acceptable.