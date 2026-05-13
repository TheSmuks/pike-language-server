/**
 * errorLog.ts — Centralized logging for the Pike Language Server.
 *
 * All log output goes through this module to ensure a consistent format:
 *
 *   2026-05-13T14:32:01.456Z INFO  parser initialized
 *   2026-05-13T14:32:01.789Z ERROR [parse] onDidChangeContent(/proj/main.pike)
 *     message: unexpected token at line 42
 *     errorId: #7
 *     stack:
 *       Error: unexpected token at line 42
 *         at parse (parser.ts:123)
 *
 * Format: <ISO timestamp> <LEVEL> <message>
 *
 * Levels: INFO, WARN, ERROR
 * - INFO:  operational messages (startup, cache restore, indexing progress)
 * - WARN:  recoverable issues (pike binary not found, degraded features)
 * - ERROR: failures with stack traces (parse errors, worker crashes)
 *
 * Architecture:
 * - errorLog is a process-global singleton — instantiated once in main.ts
 * - logError/logWarn/logInfo are the entry points for all server logging
 * - PikeWorker receives an onError callback; all its errors route through logError
 * - The client receives error count via custom notification for status bar badge
 */

import type { Connection } from "vscode-languageserver/node";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export enum ErrorCategory {
  Parse = "parse",
  Diagnostics = "diagnostics",
  Index = "index",
  Worker = "worker",
  System = "system",
}

export type LogLevel = "INFO" | "WARN" | "ERROR";

export interface LogEntry {
  /** Monotonically incrementing ID across the process lifetime. */
  id: number;
  /** ISO-8601 timestamp with millisecond precision. */
  timestamp: string;
  /** Log level: INFO, WARN, or ERROR. */
  level: LogLevel;
  /** Error domain — used for filtering. Undefined for INFO/WARN. */
  category: ErrorCategory | undefined;
  /** Human-readable message. */
  message: string;
  /** Error.stack if available, otherwise undefined. */
  stack: string | undefined;
  /**
   * Human-readable location where the error occurred.
   * Format: "methodName" or "methodName(uri)".
   */
  context: string | undefined;
}

// ---------------------------------------------------------------------------
// ErrorLog — bounded ring buffer
// ---------------------------------------------------------------------------

export class ErrorLog {
  private entries: LogEntry[] = [];
  private _nextId = 1;
  private static readonly MAX_ENTRIES = 200;

  /**
   * Add an entry to the log.
   * When the ring is full, the oldest entry is evicted.
   */
  push(entry: Omit<LogEntry, "id" | "timestamp">): LogEntry {
    const full: LogEntry = {
      ...entry,
      id: this._nextId++,
      timestamp: new Date().toISOString(),
    };
    this.entries.push(full);
    if (this.entries.length > ErrorLog.MAX_ENTRIES) {
      this.entries.shift();
    }
    return full;
  }

  /** All entries in chronological order (oldest first). */
  all(): readonly LogEntry[] {
    return this.entries;
  }

  /** Number of entries currently in the log. */
  count(): number {
    return this.entries.length;
  }

  /** Count of ERROR-level entries. */
  errorCount(): number {
    let n = 0;
    for (const e of this.entries) {
      if (e.level === "ERROR") n++;
    }
    return n;
  }

  /** Remove all entries and reset the ID counter. */
  clear(): void {
    this.entries = [];
  }
}

// ---------------------------------------------------------------------------
// Process-global singleton — instantiated once in main.ts
// ---------------------------------------------------------------------------

export const errorLog = new ErrorLog();

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/** ISO timestamp with millisecond precision. */
function now(): string {
  return new Date().toISOString();
}

/** Format a single log line: `2026-05-13T14:32:01.456Z INFO  message` */
function formatLine(ts: string, level: LogLevel, msg: string): string {
  // Pad level to 5 chars for alignment: INFO, WARN, ERROR
  const padded = level.padEnd(5);
  return `${ts} ${padded} ${msg}`;
}

// ---------------------------------------------------------------------------
// Safe connection write
// ---------------------------------------------------------------------------

/**
 * Write lines to the LSP connection console.
 * Falls back to process.stderr if the connection is closed during teardown.
 */
function safeWrite(connection: Connection, lines: string[]): void {
  const text = lines.join("\n");
  try {
    connection.console.error(text);
  } catch {
    try {
      process.stderr.write(text + "\n");
    } catch {
      // Nothing more we can do — both connection and stderr failed.
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Log an informational message.
 *
 * Format: `2026-05-13T14:32:01.456Z INFO  message`
 */
export function logInfo(connection: Connection, message: string): void {
  const ts = now();
  errorLog.push({
    level: "INFO",
    category: undefined,
    message,
    stack: undefined,
    context: undefined,
  });
  safeWrite(connection, [formatLine(ts, "INFO", message)]);
}

/**
 * Log a warning message.
 *
 * Format: `2026-05-13T14:32:01.456Z WARN  message`
 */
export function logWarn(connection: Connection, message: string): void {
  const ts = now();
  errorLog.push({
    level: "WARN",
    category: undefined,
    message,
    stack: undefined,
    context: undefined,
  });
  safeWrite(connection, [formatLine(ts, "WARN", message)]);
}

/**
 * Log an error with full context and stack trace.
 *
 * Format:
 *   2026-05-13T14:32:01.456Z ERROR [category] context
 *     message: error message
 *     errorId: #7
 *     stack:
 *       Error: ...
 *         at ...
 *
 * Also sends a `pike/errorCount` notification to the client for the
 * status bar badge.
 */
export function logError(
  connection: Connection,
  category: ErrorCategory,
  ctx: string,
  err: unknown,
): void {
  const ts = now();
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  const entry = errorLog.push({
    level: "ERROR",
    category,
    message,
    stack,
    context: ctx,
  });

  const lines: string[] = [
    formatLine(ts, "ERROR", `[${category}] ${ctx}`),
    `  message: ${message}`,
    `  errorId: #${entry.id}`,
  ];
  if (stack !== undefined) {
    lines.push(
      `  stack:\n${stack.split("\n").map((l) => "    " + l).join("\n")}`,
    );
  }

  safeWrite(connection, lines);

  // Notify the client of the updated error count so the status bar badge
  // stays current. Errors are only surfaced in the status bar — the output
  // panel always has the full log — to avoid popup spam.
  try {
    connection.sendNotification("pike/errorCount", { count: errorLog.errorCount() });
  } catch {
    // Non-critical — connection may be closed.
  }
}
