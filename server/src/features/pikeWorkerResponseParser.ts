import type { ChildProcess } from "node:child_process";
import { LSPErrorCodes } from "vscode-languageserver-protocol/lib/common/api";
import { validatePikeResponse } from "../util/jsonValidation.js";
import type { PikeResponse } from "./pikeWorkerTypes.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParsedResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface PendingRequest {
  resolve: (response: PikeResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single line of JSON from the Pike worker stdout buffer.
 * Returns a parsed response or throws if the line is not a valid response.
 */
export function parseResponseLine(line: string): ParsedResponse {
  if (!line.trim()) {
    throw new Error("Empty line");
  }
  const raw: unknown = JSON.parse(line);
  return validatePikeResponse(raw) as ParsedResponse;
}

/**
 * Process the stdout buffer of a Pike worker, extracting and resolving
 * pending requests from complete newline-delimited JSON lines.
 *
 * Calls `onResponse` for each successfully parsed response.
 * Calls `onMalformed` for each parse error, passing the error and line.
 *
 * Returns the remaining unprocessed buffer content.
 */
export function processResponseBuffer(
  buffer: string,
  pendingMap: Map<number, PendingRequest>,
  callbacks: {
    malformedRestartThreshold: number;
    onCriticalError: ((ctx: string, err: unknown) => void) | null;
    onResponse: (response: PikeResponse) => void;
    onMalformed: (err: Error, line: string, consecutiveMalformed: number) => void;
  },
): string {
  let remaining = buffer;
  let consecutiveMalformed = 0;

  while (true) {
    const newlineIdx = remaining.indexOf("\n");
    if (newlineIdx === -1) break;

    const line = remaining.slice(0, newlineIdx);
    remaining = remaining.slice(newlineIdx + 1);

    if (!line.trim()) continue;

    try {
      const raw: unknown = JSON.parse(line);
      const response = validatePikeResponse(raw) as ParsedResponse;
      consecutiveMalformed = 0;
      callbacks.onResponse(response as PikeResponse);
    } catch (err) {
      consecutiveMalformed++;
      const error = err instanceof Error ? err : new Error(String(err));
      callbacks.onMalformed(error, line, consecutiveMalformed);
    }
  }

  return remaining;
}