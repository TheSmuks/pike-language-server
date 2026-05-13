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
import { ProgressType } from "vscode-jsonrpc";
import { readdir, readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { parse } from "../parser";
import type { WorkspaceIndex } from "./workspaceIndex";
import { ModificationSource } from "./workspaceIndex";
import { logError, logInfo, ErrorCategory } from "../util/errorLog.js";

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
  /** Pike worker for type-aware indexing. Omit if Pike is unavailable. */
  worker?: { isAvailable: boolean };
  /** Progress token from the client, if it supports workDoneProgress. */
  progressToken?: string | number;
  /** Number of files to index concurrently. Default: 8. */
  batchSize?: number;
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

  const { connection, index, workspaceRoot, worker } = options;
  const batchSize = options.batchSize ?? BATCH_SIZE;

  if (!workspaceRoot) {
    logInfo(connection, "no workspace root, skipping background indexing");
    return;
  }

  // Skip type-aware indexing if Pike is unavailable.
  // Tree-sitter parsing still runs below for symbol table building.
  if (worker && !worker.isAvailable) {
    logInfo(connection, "Pike binary not found — skipping background indexing");
    return;
  }

  // Discover files via recursive directory walk
  const files: string[] = [];

  try {
    await discoverFiles(workspaceRoot, files);
  } catch (err) {
    logError(connection, ErrorCategory.Index, `indexWorkspaceFiles:discoverFiles(${workspaceRoot})`, err);
    return;
  }

  if (files.length === 0) {
    logInfo(connection, "no .pike/.pmod files found in workspace");
    return;
  }

  logInfo(connection, `indexing ${files.length} workspace files (batch size ${batchSize})`);

  // Report progress start
  let progressToken: string | number | undefined;
  try {
    const token = `pike-index-${Date.now()}`;
    await connection.sendRequest("window/workDoneProgress/create", {
      token,
    });
    progressToken = token;
  } catch {
    // Client doesn't support workDoneProgress — that's fine
  }

  if (progressToken) {
    try {
      connection.sendProgress(workDoneProgress, progressToken, {
        kind: "begin",
        title: "Indexing workspace",
        message: `Found ${files.length} files`,
      });
    } catch {
      // Ignore progress errors
    }
  }

  let indexed = 0;
  let errors = 0;

  // Filter out already-indexed files (open documents) before batching.
  const pending = files.filter(filepath => {
    const uri = 'file://' + encodeURI(filepath);
    return !index.getFile(uri);
  });

  // Process files in parallel batches: read + parse concurrently,
  // then upsert sequentially to keep the index consistent.
  for (let batchStart = 0; batchStart < pending.length; batchStart += batchSize) {
    const batch = pending.slice(batchStart, batchStart + batchSize);

    // Phase 1: Read and parse all files in the batch concurrently.
    // Parse without URI to avoid caching — these trees are immediately
    // consumed by Phase 2. With caching, concurrent parses can evict
    // each other's trees from the LRU cache, causing tree.delete() to
    // null out rootNode before Phase 2 reads it.
    const parsed: (ParsedFile | null)[] = await Promise.all(
      batch.map(async (filepath) => {
        const uri = 'file://' + encodeURI(filepath);
        try {
          const content = await readFile(filepath, "utf-8");
          const tree = parse(content);
          return { filepath, uri, content, tree };
        } catch (err) {
          errors++;
          logError(connection, ErrorCategory.Index, `indexWorkspaceFiles:readFile(${filepath})`, err);
          return null;
        }
      }),
    );

    // Phase 2: Upsert parsed files sequentially (shared mutable state).
    for (const file of parsed) {
      if (!file || !file.tree) continue;

      try {
        await index.upsertFile(
          file.uri,
          0,
          file.tree,
          file.content,
          ModificationSource.BackgroundIndex,
        );
      } catch (err) {
        errors++;
        logError(connection, ErrorCategory.Index, `indexWorkspaceFiles:upsertFile(${file.filepath})`, err);
      }

      // Release tree memory — these are not cached (parsed without URI).
      file.tree.delete();

      indexed++;
    }

    // Report progress periodically (every batch)
    if (progressToken && indexed > 0) {
      try {
        connection.sendProgress(workDoneProgress, progressToken, {
          kind: "report",
          message: `Indexed ${indexed}/${files.length} files`,
          percentage: Math.round((indexed / files.length) * 100),
        });
      } catch {
        // Ignore progress errors
      }
    }

    // Yield to the event loop between batches
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // Report completion
  if (progressToken) {
    try {
      connection.sendProgress(workDoneProgress, progressToken, {
        kind: "end",
        message: `Indexed ${indexed} files (${errors} errors)`,
      });
    } catch {
      // Ignore progress errors
    }
  }

  logInfo(
    connection,
    `background indexing complete — ${indexed} files indexed, ${errors} errors`,
  );
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
