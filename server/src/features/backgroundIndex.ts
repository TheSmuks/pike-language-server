/**
 * Background workspace indexing.
 *
 * On startup, discovers and indexes all .pike/.pmod files in the workspace.
 * Reports progress via window/workDoneProgress.
 * Yields between files to avoid blocking the event loop.
 *
 * Design: fire-and-forget from onInitialized. Errors are logged, not thrown.
 */

import type { Connection } from "vscode-languageserver/node";
import { ProgressType } from "vscode-jsonrpc";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { parse } from "../parser";
import type { WorkspaceIndex } from "./workspaceIndex";
import { ModificationSource } from "./workspaceIndex";

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
  /** Progress token from the client, if it supports workDoneProgress. */
  progressToken?: string | number;
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
  const { connection, index, workspaceRoot } = options;

  if (!workspaceRoot) {
    connection.console.log("Pike LSP: no workspace root, skipping background indexing");
    return;
  }

  // Discover files
  const pikeGlob = new Glob("**/*.{pike,pmod}");
  const files: string[] = [];

  try {
    for await (const path of pikeGlob.scan({ cwd: workspaceRoot, absolute: true })) {
      files.push(path);
    }
  } catch (err) {
    connection.console.error(
      `Pike LSP: workspace file discovery failed: ${(err as Error).message}`,
    );
    return;
  }

  if (files.length === 0) {
    connection.console.log("Pike LSP: no .pike/.pmod files found in workspace");
    return;
  }

  connection.console.log(`Pike LSP: indexing ${files.length} workspace files`);

  // Report progress start
  let progressToken: string | number | undefined;
  try {
    const result = await connection.sendRequest("window/workDoneProgress/create", {
      token: `pike-index-${Date.now()}`,
    });
    progressToken = `pike-index-${Date.now()}`;
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

  for (const filepath of files) {
    try {
      // Skip already-indexed files (open documents)
      const uri = `file://${filepath}`;
      if (index.getFile(uri)) {
        indexed++;
        continue;
      }

      // Read and parse
      const content = await readFile(filepath, "utf-8");
      const tree = parse(content, uri);

      index.upsertFile(uri, 0, tree, content, ModificationSource.BackgroundIndex);

      indexed++;

      // Report progress periodically (every 10 files)
      if (progressToken && indexed % 10 === 0) {
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

      // Yield to the event loop between files
      await new Promise(resolve => setTimeout(resolve, 0));
    } catch (err) {
      errors++;
      connection.console.error(
        `Pike LSP: failed to index ${filepath}: ${(err as Error).message}`,
      );
    }
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

  connection.console.log(
    `Pike LSP: background indexing complete — ${indexed} files indexed, ${errors} errors`,
  );
}
