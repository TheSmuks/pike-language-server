/**
 * Append-only JSONL ledger for the LSP audit sweep.
 *
 * Every record is flushed as it is written. A sweep over the Roxen tree runs
 * for tens of minutes; a crash must cost one record, not the run. Triage then
 * reads the persisted ledger, so re-triaging with different thresholds never
 * requires re-sweeping.
 */

import { closeSync, openSync, readFileSync, writeSync, existsSync } from "node:fs";

export type Tier = 0 | 1 | 2 | 3;
export type Surface = "server" | "roxen" | "client" | "standalone";
/**
 * "wrong" means the server answered, but not with the known-correct answer.
 * It can only be decided while the result is in hand, so the sweep sets it —
 * the ledger stores a digest, not the result, and triage cannot recover it.
 */
export type Status = "ok" | "empty" | "error" | "timeout" | "wrong";

export interface LedgerRecord {
  surface: Surface;
  /** Workspace label, e.g. "corpus" or "roxen-6.1". */
  workspace: string;
  /** LSP method, e.g. "textDocument/hover". */
  capability: string;
  /** Workspace-relative path. */
  file: string;
  /** Null for document-, workspace- and lifecycle-driven capabilities. */
  position: { line: number; character: number } | null;
  status: Status;
  durationMs: number;
  rssBytes: number;
  /** Short summary of the result, enough for triage without storing it all. */
  digest: string;
  /** Error text when status is "error". */
  detail?: string;
}

export class Ledger {
  private fd: number;

  constructor(path: string) {
    this.fd = openSync(path, "a");
  }

  append(record: LedgerRecord): void {
    writeSync(this.fd, JSON.stringify(record) + "\n");
  }

  close(): void {
    closeSync(this.fd);
  }
}

/**
 * Read a ledger, discarding a trailing partial line.
 *
 * A crash mid-write leaves an incomplete final record. That is expected, not
 * corruption, so it is dropped silently rather than thrown on.
 */
export function readLedger(path: string): LedgerRecord[] {
  if (!existsSync(path)) return [];
  const records: LedgerRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.length === 0) continue;
    try {
      records.push(JSON.parse(line) as LedgerRecord);
    } catch {
      // Partial trailing line from an interrupted sweep.
    }
  }
  return records;
}
