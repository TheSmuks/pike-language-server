/**
 * Formatting handler — thin wrapper that shells out to pike-fmt.
 *
 * Architecture follows gopls/rust-analyzer pattern: the LSP does not implement
 * formatting logic itself. Instead it spawns the standalone pike-fmt tool,
 * pipes document text to it, diffs the output, and returns TextEdit[].
 *
 * Phase 1 scope: whole-document formatting only. No range formatting.
 */

import {
  type Connection,
  type DocumentFormattingParams,
  type TextEdit,
  type FormattingOptions,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { spawn } from "node:child_process";
import type { TextDocuments } from "vscode-languageserver/node";

interface FormattingContext {
  documents: TextDocuments<TextDocument>;
  /** Path to pike-fmt binary. Set via initializationOptions or config. */
  pikeFmtPath: string;
}

/**
 * Compute minimal TextEdit[] that transforms original into formatted.
 *
 * Simple line-by-line diff: for each line, if the leading whitespace differs,
 * produce a replace edit for that line's indentation.
 */
function computeIndentEdits(
  original: string,
  formatted: string,
): TextEdit[] {
  const origLines = original.split("\n");
  const fmtLines = formatted.split("\n");
  const edits: TextEdit[] = [];

  // Process line by line up to the longer of the two
  const maxLen = Math.max(origLines.length, fmtLines.length);
  for (let i = 0; i < maxLen; i++) {
    const origLine = origLines[i] ?? "";
    const fmtLine = fmtLines[i] ?? "";

    // Extract leading whitespace
    const origIndent = origLine.match(/^\s*/)?.[0] ?? "";
    const fmtIndent = fmtLine.match(/^\s*/)?.[0] ?? "";

    if (origIndent !== fmtIndent) {
      edits.push({
        range: {
          start: { line: i, character: 0 },
          end: { line: i, character: origIndent.length },
        },
        newText: fmtIndent,
      });
    }
  }

  // Handle trailing newline difference
  const origHasNewline = original.endsWith("\n");
  const fmtHasNewline = formatted.endsWith("\n");
  if (!origHasNewline && fmtHasNewline) {
    const lastLine = origLines.length > 0 ? origLines.length - 1 : 0;
    edits.push({
      range: {
        start: { line: lastLine, character: (origLines[lastLine] ?? "").length },
        end: { line: lastLine, character: (origLines[lastLine] ?? "").length },
      },
      newText: "\n",
    });
  }

  return edits;
}

/**
 * Register the document formatting handler on the connection.
 *
 * The handler spawns pike-fmt as a subprocess with the document text on stdin.
 * If pike-fmt is not available, returns a plain text error response.
 */
export function registerFormattingHandler(
  connection: Connection,
  ctx: FormattingContext,
): void {
  connection.onDocumentFormatting(
    async (params: DocumentFormattingParams): Promise<TextEdit[] | null> => {
      const doc = ctx.documents.get(params.textDocument.uri);
      if (!doc) return null;

      const source = doc.getText();
      const options: FormattingOptions = params.options;

      return new Promise((resolve) => {
        // Spawn pike-fmt with formatting options as args
        // --tab-size: number of spaces per tab (tabSize from options)
        // --use-tabs: boolean (insertSpaces === false)
        const args = [
          "--tab-size",
          String(options.tabSize ?? 2),
          ...(options.insertSpaces === false
            ? ["--use-tabs"]
            : []),
        ];

        let stdout = "";
        let stderr = "";
        let killed = false;

        const child = spawn(ctx.pikeFmtPath, args, {
          stdio: ["pipe", "pipe", "pipe"],
          // Don't inherit the parent environment — keep PATH clean
          env: { ...process.env, PATH: process.env.PATH ?? "" },
        });

        const timeout = setTimeout(() => {
          killed = true;
          child.kill("SIGTERM");
        }, 30_000);

        child.stdout?.on("data", (chunk) => {
          stdout += chunk.toString();
        });

        child.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        child.on("close", (code) => {
          clearTimeout(timeout);
          if (killed) {
            connection.console.error(
              `pike-fmt timed out after 30s for ${params.textDocument.uri}`,
            );
            resolve(null);
            return;
          }

          if (code !== 0 || stderr.length > 0) {
            connection.console.error(
              `pike-fmt exited with code ${code}: ${stderr}`,
            );
            // Return error as a diagnostic-like message
            resolve(null);
            return;
          }

          // Compute indent edits
          const edits = computeIndentEdits(source, stdout);
          resolve(edits);
        });

        child.on("error", (err) => {
          clearTimeout(timeout);
          connection.console.error(
            `Failed to spawn pike-fmt at ${ctx.pikeFmtPath}: ${err.message}`,
          );
          resolve(null);
        });

        // Write source to pike-fmt's stdin
        child.stdin?.write(source, () => {
          child.stdin?.end();
        });
      });
    },
  );
}