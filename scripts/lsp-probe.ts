#!/usr/bin/env bun
/**
 * Headless LSP probe — drive the Pike language server from the command line.
 *
 * This is the "debug while developing" tool: it boots the real server in-process
 * (same code path as production, via createTestServer), opens a Pike file, and
 * fires any LSP request, printing a decoded, human-readable result. No VSCode,
 * no VSIX, no round-trip — just observe what the server actually returns.
 *
 * Why: the extension's syntax highlighting is driven by semantic tokens, which
 * ship as a flat delta-encoded int array that is impossible to eyeball. This
 * tool decodes them back into (line, col, length, type, modifiers, text) rows
 * so a wrong or missing token is obvious. The same mechanism exercises hover,
 * completion, definition, symbols, and diagnostics.
 *
 * Usage:
 *   bun run scripts/lsp-probe.ts tokens   <file> [--summary]
 *   bun run scripts/lsp-probe.ts hover     <file> <line>:<col>
 *   bun run scripts/lsp-probe.ts complete  <file> <line>:<col>
 *   bun run scripts/lsp-probe.ts define    <file> <line>:<col>
 *   bun run scripts/lsp-probe.ts symbols   <file>
 *   bun run scripts/lsp-probe.ts diagnostics <file>
 *   bun run scripts/lsp-probe.ts capabilities
 *   bun run scripts/lsp-probe.ts raw <method> <file> [jsonParams]
 *   bun run scripts/lsp-probe.ts notify <method> <file> [jsonParams]
 *
 * Positions are 1-based (line and column, as editors display them) and are
 * converted to LSP's 0-based coordinates internally.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createTestServer, type TestServer } from "../tests/lsp/helpers";
import { SEMANTIC_TOKENS_LEGEND } from "../server/src/features/semanticTokens";
import { buildServerCapabilities } from "../server/src/serverCapabilities";
import { decodeSource } from "../server/src/util/sourceDecoder";

/** A decoded semantic token with absolute coordinates and resolved names. */
interface DecodedToken {
  line: number;
  character: number;
  length: number;
  type: string;
  modifiers: string[];
  text: string;
}

/** Parse a "line:col" argument (1-based) into 0-based LSP coordinates. */
function parsePosition(arg: string): { line: number; character: number } {
  const match = /^(\d+):(\d+)$/.exec(arg);
  if (!match) {
    throw new Error(`position must be "line:col" (1-based), got: ${arg}`);
  }
  return { line: Number(match[1]) - 1, character: Number(match[2]) - 1 };
}

/**
 * Resolve a file path argument to an absolute file:// URI and its text.
 *
 * Decoded by detected encoding, not as UTF-8. This tool exists to show what
 * the server returns for a real file, and the server decodes the same way —
 * reading an ISO-8859-1 file as UTF-8 here would replace every high byte with
 * U+FFFD and silently shift every position the probe prints.
 */
function loadFile(pathArg: string): { uri: string; text: string; sourceLines: string[] } {
  const absolute = resolve(pathArg);
  const text = decodeSource(readFileSync(absolute)).text;
  return { uri: pathToFileURL(absolute).href, text, sourceLines: text.split("\n") };
}

/** Decode the LSP delta-encoded semantic token array into absolute rows. */
function decodeTokens(data: number[], sourceLines: string[]): DecodedToken[] {
  const tokens: DecodedToken[] = [];
  let line = 0;
  let character = 0;
  for (let i = 0; i + 4 < data.length; i += 5) {
    const deltaLine = data[i];
    const deltaChar = data[i + 1];
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaChar : deltaChar;
    const length = data[i + 2];
    const type = SEMANTIC_TOKENS_LEGEND.tokenTypes[data[i + 3]] ?? `?${data[i + 3]}`;
    const modifiers = decodeModifiers(data[i + 4]);
    const text = (sourceLines[line] ?? "").slice(character, character + length);
    tokens.push({ line, character, length, type, modifiers, text });
  }
  return tokens;
}

/** Expand a modifier bitmask into the legend's modifier names. */
function decodeModifiers(mask: number): string[] {
  const names: string[] = [];
  for (let bit = 0; bit < SEMANTIC_TOKENS_LEGEND.tokenModifiers.length; bit++) {
    if (mask & (1 << bit)) names.push(SEMANTIC_TOKENS_LEGEND.tokenModifiers[bit]);
  }
  return names;
}

/** Print decoded tokens as an aligned table, or a per-type summary. */
function printTokens(tokens: DecodedToken[], summary: boolean): void {
  if (tokens.length === 0) {
    console.log("(no semantic tokens returned — highlighting would fall back to TextMate only)");
    return;
  }
  if (summary) {
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t.type, (counts.get(t.type) ?? 0) + 1);
    console.log(`${tokens.length} tokens across ${counts.size} types:`);
    for (const [type, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(count).padStart(5)}  ${type}`);
    }
    return;
  }
  console.log(`${tokens.length} tokens (line:col len  type [modifiers]  → text):`);
  for (const t of tokens) {
    const pos = `${t.line + 1}:${t.character + 1}`.padEnd(9);
    const mods = t.modifiers.length ? ` [${t.modifiers.join(",")}]` : "";
    console.log(`  ${pos} ${String(t.length).padStart(3)}  ${t.type}${mods}  → ${JSON.stringify(t.text)}`);
  }
}

/** Wait for the first publishDiagnostics notification for the given URI. */
function waitForDiagnostics(server: TestServer, uri: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(null), timeoutMs);
    server.client.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: unknown[] }) => {
      if (params.uri !== uri) return;
      clearTimeout(timer);
      resolvePromise(params.diagnostics);
    });
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(2, 39).join("\n").replace(/^ \*?/gm, ""));
    process.exit(command ? 0 : 1);
  }

  // "capabilities" needs no server boot — report what the server advertises.
  if (command === "capabilities") {
    console.log(JSON.stringify(buildServerCapabilities().capabilities, null, 2));
    return;
  }

  const fileArg = command === "raw" || command === "notify" ? rest[1] : rest[0];
  if (!fileArg) throw new Error(`command "${command}" requires a <file> argument`);
  const { uri, text, sourceLines } = loadFile(fileArg);

  // Root the workspace at the file's directory so cross-file features and
  // background indexing can see sibling modules.
  const server = await createTestServer({ rootUri: pathToFileURL(dirname(resolve(fileArg))).href });
  try {
    // Register the diagnostics listener before opening the document so we do
    // not miss the notification the server publishes right after didOpen.
    const diagnosticsPromise = command === "diagnostics" ? waitForDiagnostics(server, uri, 20_000) : null;
    server.openDoc(uri, text);

    if (command === "tokens") {
      const result = await server.client.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri } }) as { data: number[] } | null;
      printTokens(result ? decodeTokens(result.data, sourceLines) : [], rest.includes("--summary"));
    } else if (command === "diagnostics") {
      console.log(JSON.stringify(await diagnosticsPromise, null, 2));
    } else if (command === "symbols") {
      const result = await server.client.sendRequest("textDocument/documentSymbol", { textDocument: { uri } });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "hover" || command === "define" || command === "complete") {
      const method = command === "hover" ? "textDocument/hover"
        : command === "define" ? "textDocument/definition"
        : "textDocument/completion";
      const position = parsePosition(rest[1] ?? "");
      const result = await server.client.sendRequest(method, { textDocument: { uri }, position });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === "notify") {
      // Lifecycle capabilities are notifications: there is no reply to print.
      // A lifecycle finding is a crash, so the reproduction sends the
      // notification and then proves the server is still answering.
      const method = rest[0];
      if (!method) throw new Error("notify requires a <method> argument");
      const extraParams = rest[2] ? JSON.parse(rest[2]) : {};
      // The version is REQUIRED. vscode-languageserver's TextDocuments throws
      // "without valid version identifier" on a versionless didChange, and
      // vscode-jsonrpc catches that inside its notification dispatcher and
      // routes it to a log channel nothing here listens to — so the change is
      // dropped in total silence and the command reports success. The document
      // is opened at version 1, so 2 is the next one.
      server.client.sendNotification(method, {
        textDocument: { uri, version: 2 },
        ...extraParams,
      });
      const alive = await server.client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri },
      });
      console.log(`notification sent: ${method}`);
      console.log(`server still responding: ${Array.isArray(alive) ? `${alive.length} symbols` : "yes"}`);
    } else if (command === "raw") {
      const method = rest[0];
      if (!method) throw new Error("raw requires a <method> argument");
      const extraParams = rest[2] ? JSON.parse(rest[2]) : {};
      const result = await server.client.sendRequest(method, { textDocument: { uri }, ...extraParams });
      console.log(JSON.stringify(result, null, 2));
    } else {
      throw new Error(`unknown command: ${command}`);
    }
  } finally {
    await server.teardown();
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`lsp-probe error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
