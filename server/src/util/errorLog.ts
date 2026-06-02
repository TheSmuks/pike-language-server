/**
 * errorLog.ts — Centralized logging for the Pike Language Server.
 *
 * All log output goes through this module to ensure a consistent format
 * matching the client-side output channel:
 *
 *   [20:08:22.826] [SERVER] [init] step 6: onInitialize — client connected
 *   [20:08:22.895] [SERVER] ⚠  no cache found — fresh start
 *   [20:08:22.895] [SERVER] ✖  [index] upsertFile(/path/to/file.pike)
 *     message: Cannot read properties of null
 *     errorId: #7
 *     stack:
 *       Error: ...
 *
 * Architecture:
 * - Server logs are sent via custom `pike/log` notification to the client,
 *   which writes them to the shared OutputChannel using the same format as
 *   client-side logs. This avoids VSCode's `[Error - ...]` / `[Log - ...]`
 *   prefixes that `connection.console` methods produce.
 * - errorLog is a process-global singleton — instantiated once in main.ts
 * - logError/logWarn/logInfo are the entry points for all server logging
 * - PikeWorker receives an onError callback; all its errors route through logError
 * - The client receives error count via `pike/errorCount` notification for
 *   the status bar badge.
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

/** Pre-computed set of ErrorCategory values for fast lookup in logWarn. */
const ERROR_CATEGORY_VALUES = new Set<string>(Object.values(ErrorCategory));
let logPathRedactionEnabled = true;

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
    this._nextId = 1;
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

/**
 * Redact likely sensitive local paths and file:// URIs from log text.
 */
function sanitizeLogText(text: string): string {
  if (!logPathRedactionEnabled) return text;

  let out = text;

  // file:///abs/path or file://C:/path
  out = out.replace(/file:\/\/(?:\/)?[^\s)\]"']+/g, "<file-uri>");

  // Unix absolute paths (best-effort): /a/b, /home/user/project/file.pike
  out = out.replace(/(^|[\s(\["'])\/(?:[^\s/]+\/)+[^\s)\]"']+/g, "$1<path>");

  // Windows absolute paths: C:\Users\name\file
  out = out.replace(/\b[A-Za-z]:\\(?:[^\\\s]+\\)+[^\\\s)\]"']+/g, "<path>");

  return out;
}

/**
 * Toggle best-effort path redaction for logs written after this call.
 *
 * The raw ErrorLog ring buffer keeps original messages so developers can
 * opt into full paths locally without losing context. Copy/paste report
 * blocks and output-channel notifications honor the current setting.
 */
export function setLogPathRedactionEnabled(enabled: boolean): void {
  logPathRedactionEnabled = enabled;
}

/** Build a self-contained issue report block for copy/paste bug reports. */
function buildIssueReportBlock(entry: LogEntry): string[] {
  const lines: string[] = [
    "[pike-lsp-report] --- BEGIN ---",
    `id: ${entry.id}`,
    `timestamp: ${entry.timestamp}`,
    `level: ${entry.level}`,
    `category: ${entry.category ?? "unknown"}`,
    `context: ${sanitizeLogText(entry.context ?? "unknown")}`,
    `message: ${sanitizeLogText(entry.message)}`,
  ];

  if (entry.stack) {
    lines.push("stack:");
    for (const line of entry.stack.split("\n")) {
      lines.push(`  ${sanitizeLogText(line)}`);
    }
  }

  lines.push("[pike-lsp-report] --- END ---");
  return lines;
}

// ---------------------------------------------------------------------------
// Safe connection write via custom notification
// ---------------------------------------------------------------------------

/**
 * Send log lines to the client via `pike/log` notification.
 *
 * The client writes them to the shared OutputChannel using the same
 * `[HH:MM:SS.mmm] [SERVER]` format as client-side logs, ensuring a
 * consistent appearance in the Output panel.
 *
 * Falls back to `connection.console.error()` (and then stderr) if the
 * custom notification is not yet registered or the connection is down.
 */
function safeWrite(connection: Connection, level: LogLevel, lines: string[]): void {
  const sanitizedLines = lines.map(sanitizeLogText);
  const text = sanitizedLines.join("\n");
  try {
    connection.sendNotification("pike/log", { level, lines: sanitizedLines });
  } catch {
    // Custom notification not registered (early startup or teardown).
    // Fall back to connection.console so the message is not lost.
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
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Log an informational message.
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
  safeWrite(connection, "INFO", [message]);
}

/**
 * Log a warning with an optional context label.
 *
 * Unlike logError, warnings do not increment the error count badge and do
 * not send a pike/errorCount notification.
 */
export function logWarn(
  connection: Connection,
  messageOrCategory: ErrorCategory | string,
  maybeMessage?: string,
  maybeCtx?: string,
): void {
  // ErrorCategory is a string enum, so typeof cannot distinguish it from a
  // plain string.  Check against the known enum values to detect category usage.
  const isCategory = ERROR_CATEGORY_VALUES.has(messageOrCategory as string) && maybeMessage !== undefined;
  const category = isCategory ? messageOrCategory as ErrorCategory : undefined;
  const message = isCategory ? maybeMessage : (messageOrCategory as string);
  const ctx = maybeCtx;

  const entry = errorLog.push({
    level: "WARN",
    category,
    message: ctx ? `[${ctx}] ${message}` : message,
    stack: undefined,
    context: ctx,
  });

  const lines: string[] = [message];
  if (category !== undefined) {
    lines.push(...buildIssueReportBlock(entry));
  }

  safeWrite(connection, "WARN", lines);
}

/**
 * Log an error with full context and stack trace.
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
    `[${category}] ${ctx}`,
    `    message: ${message}`,
    `    errorId: #${entry.id}`,
  ];
  if (stack !== undefined) {
    lines.push(
      `    stack:\n${stack.split("\n").map((l) => "      " + l).join("\n")}`,
    );
  }

  lines.push(...buildIssueReportBlock(entry));

  safeWrite(connection, "ERROR", lines);

  // Notify the client of the updated error count so the status bar badge
  // stays current. Errors are only surfaced in the status bar — the output
  // panel always has the full log — to avoid popup spam.
  try {
    connection.sendNotification("pike/errorCount", { count: errorLog.errorCount() });
  } catch {
    // Non-critical — connection may be closed.
  }
}
