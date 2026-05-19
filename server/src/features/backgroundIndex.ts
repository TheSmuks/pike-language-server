/**
 * Background workspace indexing.
 *
 * On startup, discovers and indexes all .pike/.pmod files in the workspace.
 * Reports progress via window/workDoneProgress.
 *
 * Files are read and parsed in parallel batches for throughput, then fed to
 * WorkspaceIndex.upsertFile() sequentially (it mutates shared maps). This
 * keeps the index consistent while maximizing I/O and CPU parallelism.
 */

import type { Connection } from "vscode-languageserver/node";
import type { CancellationToken } from "vscode-jsonrpc";
import { ProgressType } from "vscode-jsonrpc";
import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "../parser";
import type { WorkspaceIndex } from "./workspaceIndex";
import { logError, logInfo, logWarn, ErrorCategory } from "../util/errorLog.js";
import { startSpan, stopSpan, bump, measureAsync } from "./profiler";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const workDoneProgress = new ProgressType<{
  kind: string;
  title?: string;
  message?: string;
  percentage?: number;
}>();


export interface BackgroundIndexOptions {
  connection: Connection;
  index: WorkspaceIndex;
  workspaceRoot: string;
  /** Number of files to index concurrently. Default: 8. */
  batchSize?: number;
  /** Token to cancel background indexing between batches. */
  cancellationToken?: CancellationToken;
}

/** Parsed file ready for insertion into the index. */
interface ParsedFile {
  filepath: string;
  uri: string;
  content: string;
  tree: import("web-tree-sitter").Tree | null;
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Maximum number of files to read and parse concurrently.
 *
 * Tree-sitter parsing is CPU-bound; file reads are I/O-bound. A batch size
 * of ~8 saturates both without excessive memory pressure (each parsed tree
 * is small — typically 10–500 KB).
 */
const BATCH_SIZE = 8;

// ---------------------------------------------------------------------------
// Progress helpers
// ---------------------------------------------------------------------------

/**
 * Create a work-done-progress token and send the "begin" notification.
 * Returns `undefined` if the client doesn't support progress reporting.
 */
async function createProgressReporter(
  connection: Connection,
  totalFiles: number,
): Promise<string | number | undefined> {
  let token: string | number | undefined;
  try {
    token = `pike-index-${Date.now()}`;
    await connection.sendRequest("window/workDoneProgress/create", { token });
  } catch {
    // Client doesn't support workDoneProgress — that's fine
  }

  if (token) {
    try {
      connection.sendProgress(workDoneProgress, token, {
        kind: "begin",
        title: "Indexing workspace",
        message: `Found ${totalFiles} files`,
      });
    } catch {
      // Ignore progress errors
    }
  }
  return token;
}

/** Send a progress "report" tick (percentage complete). */
function reportProgress(
  connection: Connection,
  token: string | number | undefined,
  indexed: number,
  totalFiles: number,
): void {
  if (!token || indexed <= 0) return;
  try {
    connection.sendProgress(workDoneProgress, token, {
      kind: "report",
      message: `Indexed ${indexed}/${totalFiles} files`,
      percentage: Math.round((indexed / totalFiles) * 100),
    });
  } catch {
    // Ignore progress errors
  }
}

/** Send a progress "end" notification. */
function reportProgressDone(
  connection: Connection,
  token: string | number | undefined,
  indexed: number,
  errors: number,
): void {
  if (!token) return;
  try {
    connection.sendProgress(workDoneProgress, token, {
      kind: "end",
      message: `Indexed ${indexed} files (${errors} errors)`,
    });
  } catch {
    // Ignore progress errors
  }
}

// ---------------------------------------------------------------------------
// Batch processing
// ---------------------------------------------------------------------------

/** Read + parse a single file; returns null on failure. */
async function parseFile(
  filepath: string,
  connection: Connection,
): Promise<ParsedFile | null> {
  const uri = pathToFileURL(filepath).href;
  try {
    startSpan("readFile");
    const content = await measureAsync("readFile", () => readFile(filepath, "utf-8"));
    stopSpan("readFile");
    bump("fileReads");
    const tree = parse(content);
    return { filepath, uri, content, tree };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "ENOENT") {
      logWarn(connection, `skipping ${filepath}: ${code}`);
    } else {
      logError(connection, ErrorCategory.Index, `indexWorkspaceFiles:readFile(${filepath})`, err);
    }
    return null;
  }
}

/**
 * Insert parsed files into the index using the fast background path.
 *
 * Uses upsertBackgroundFile() which is synchronous and skips async dependency
 * resolution. Dependencies are resolved lazily when files are opened or queried.
 * This makes bulk indexing ~10× faster by eliminating per-file async fs ops.
 */
function upsertParsedBatch(
  parsed: (ParsedFile | null)[],
  index: WorkspaceIndex,
  connection: Connection,
): { indexed: number; errors: number } {
  let indexed = 0;
  let errors = 0;

  for (const file of parsed) {
    if (!file || !file.tree) continue;

    try {
      index.upsertBackgroundFile(
        file.uri,
        0,
        file.tree,
        file.content,
      );
    } catch (err) {
      errors++;
      logError(connection, ErrorCategory.Index, `indexWorkspaceFiles:upsertBackgroundFile(${file.filepath})`, err);
    }

    // Release tree memory — these are not cached (parsed without URI).
    file.tree.delete();
    indexed++;
  }
  return { indexed, errors };
}

/**
 * Process all pending files in batches.
 * Reads + parses concurrently per batch, upserts sequentially.
 * Checks cancellation token between batches — stops cleanly if cancelled.
 */
async function processBatches(
  connection: Connection,
  index: WorkspaceIndex,
  pending: string[],
  batchSize: number,
  progressToken: string | number | undefined,
  totalFiles: number,
  cancellationToken?: CancellationToken,
): Promise<{ indexed: number; errors: number; cancelled: boolean }> {
  let indexed = 0;
  let errors = 0;

  for (let start = 0; start < pending.length; start += batchSize) {
    // Check cancellation between batches — exit early without error.
    if (cancellationToken?.isCancellationRequested) {
      logInfo(connection, `background indexing cancelled after ${indexed}/${totalFiles} files`);
      return { indexed, errors, cancelled: true };
    }

    const batch = pending.slice(start, start + batchSize);

    // Phase 1: Read and parse concurrently (no URI to avoid cache eviction)
    startSpan("batchParse");
    const parsed: (ParsedFile | null)[] = await measureAsync("batchParse", () =>
      Promise.all(batch.map(fp => parseFile(fp, connection))),
    );
    stopSpan("batchParse");

    // Phase 2: Insert sequentially (shared mutable state, now synchronous)
    startSpan("batchUpsert");
    const result = upsertParsedBatch(parsed, index, connection);
    stopSpan("batchUpsert");
    indexed += result.indexed;
    errors += result.errors;

    reportProgress(connection, progressToken, indexed, totalFiles);

    // Yield to the event loop between batches
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { indexed, errors, cancelled: false };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Index all .pike and .pmod files in the workspace.
 *
 * This is fire-and-forget — errors are logged to the connection console.
 * Does not block the caller; runs asynchronously.
 */
export async function indexWorkspaceFiles(
  options: BackgroundIndexOptions,
): Promise<void> {
  startSpan("backgroundIndex");

  const { connection, index, workspaceRoot } = options;
  const batchSize = options.batchSize ?? BATCH_SIZE;

  if (!workspaceRoot) {
    logInfo(connection, "no workspace root, skipping background indexing");
    return;
  }

  // Discover files via recursive directory walk
  const files: string[] = [];
  try {
    await measureAsync("discoverFiles", () => discoverFiles(workspaceRoot, files));
  } catch (err) {
    logError(connection, ErrorCategory.Index, `indexWorkspaceFiles:discoverFiles(${workspaceRoot})`, err);
    return;
  }

  if (files.length === 0) {
    logInfo(connection, "no .pike/.pmod files found in workspace");
    return;
  }

  logInfo(connection, `indexing ${files.length} workspace files (batch size ${batchSize})`);

  const progressToken = await createProgressReporter(connection, files.length);

  // Filter out already-indexed files (open documents) before batching
  const pending = files.filter(fp => !index.getFile(pathToFileURL(fp).href));

  const { indexed, errors } = await processBatches(
    connection, index, pending, batchSize, progressToken, files.length,
    options.cancellationToken,
  );

  reportProgressDone(connection, progressToken, indexed, errors);

  logInfo(
    connection,
    `background indexing complete — ${indexed} files indexed, ${errors} errors`,
  );

  bump("filesDiscovered", files.length);
  stopSpan("backgroundIndex");
}

/**
 * Recursively discover .pike and .pmod files in a directory.
 */
async function discoverFiles(dir: string, results: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Directory unreadable (permissions, deleted during scan) — skip silently
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      await discoverFiles(fullPath, results);
    } else if (entry.isFile()) {
      const ext = extname(entry.name);
      if (ext === ".pike" || ext === ".pmod") {
        results.push(fullPath);
      }
    }
  }
}
