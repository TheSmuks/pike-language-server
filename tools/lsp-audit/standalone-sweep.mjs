#!/usr/bin/env node
/**
 * Surface 4: sweep every capability over real stdio as a non-VSCode client.
 *
 * Deliberately shares no code with tools/lsp-audit/sweep.ts. That sweep boots
 * the server in-process, so it can never cross a real pipe or negotiate with a
 * client that is not VSCode — which is exactly where VSCode-only assumptions
 * hide. This one spawns the shipped standalone bundle and talks to it the way
 * Neovim or Helix would.
 *
 * Run after `bun run build:standalone`.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "./lsp-stdio.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUNDLE = join(ROOT, "standalone", "server.js");

// Symbol names avoid Pike stdlib and predef collisions (`name`, `count`,
// `size`): the rename guard rejects those by name, which would fail this sweep
// for reasons unrelated to the standalone path. See docs/other-editors.md.
const FIXTURE = `class Greeter {
  string label;
  void create(string initial) { label = initial; }
  string speak() { return label + "!"; }
}

int main() {
  Greeter greeter = Greeter("hi");
  write(greeter->speak() + "\\n");
  return 0;
}
`;

// A deliberately minimal client: no hierarchical document symbols, no
// resolveSupport, no snippets. A server that assumes those exist breaks in
// Helix, and that is a finding.
const CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: { didSave: true },
    hover: { contentFormat: ["markdown", "plaintext"] },
    completion: { completionItem: { snippetSupport: false } },
    documentSymbol: { hierarchicalDocumentSymbolSupport: false },
    semanticTokens: {
      requests: { full: { delta: true }, range: true },
      tokenTypes: [],
      tokenModifiers: [],
      formats: ["relative"],
    },
  },
  workspace: { workspaceEdit: { documentChanges: true } },
};

// Position 8:12 sits inside `greeter->speak()` on the write() line.
const POSITION = { line: 8, character: 12 };
const RANGE = { start: { line: 0, character: 0 }, end: { line: 10, character: 0 } };

const requests = (uri) => [
  ["textDocument/hover", { textDocument: { uri }, position: POSITION }],
  ["textDocument/definition", { textDocument: { uri }, position: POSITION }],
  ["textDocument/declaration", { textDocument: { uri }, position: POSITION }],
  ["textDocument/typeDefinition", { textDocument: { uri }, position: POSITION }],
  ["textDocument/implementation", { textDocument: { uri }, position: POSITION }],
  ["textDocument/references", { textDocument: { uri }, position: POSITION, context: { includeDeclaration: true } }],
  ["textDocument/prepareRename", { textDocument: { uri }, position: POSITION }],
  ["textDocument/rename", { textDocument: { uri }, position: POSITION, newName: "auditRenamedSymbol" }],
  ["textDocument/documentHighlight", { textDocument: { uri }, position: POSITION }],
  ["textDocument/signatureHelp", { textDocument: { uri }, position: POSITION, context: { triggerKind: 1, isRetrigger: false } }],
  ["textDocument/selectionRange", { textDocument: { uri }, positions: [POSITION] }],
  ["textDocument/prepareCallHierarchy", { textDocument: { uri }, position: POSITION }],
  ["textDocument/prepareTypeHierarchy", { textDocument: { uri }, position: POSITION }],
  ["textDocument/completion", { textDocument: { uri }, position: POSITION, context: { triggerKind: 1 } }],
  ["textDocument/documentSymbol", { textDocument: { uri } }],
  ["textDocument/semanticTokens/full", { textDocument: { uri } }],
  ["textDocument/semanticTokens/range", { textDocument: { uri }, range: RANGE }],
  ["textDocument/foldingRange", { textDocument: { uri } }],
  ["textDocument/documentLink", { textDocument: { uri } }],
  ["textDocument/codeLens", { textDocument: { uri } }],
  ["textDocument/inlayHint", { textDocument: { uri }, range: RANGE }],
  ["textDocument/codeAction", { textDocument: { uri }, range: RANGE, context: { diagnostics: [] } }],
  ["textDocument/formatting", { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } }],
  ["textDocument/rangeFormatting", { textDocument: { uri }, range: RANGE, options: { tabSize: 2, insertSpaces: true } }],
  ["textDocument/onTypeFormatting", { textDocument: { uri }, position: { line: 0, character: 0 }, ch: "}", options: { tabSize: 2, insertSpaces: true } }],
  ["workspace/symbol", { query: "Greeter" }],
];

/** Empty is legal for these — an absent result is not a defect. */
const EMPTY_IS_LEGAL = new Set([
  "textDocument/typeDefinition",
  "textDocument/implementation",
  "textDocument/documentLink",
  "textDocument/codeLens",
  "textDocument/inlayHint",
  "textDocument/codeAction",
  "textDocument/formatting",
  "textDocument/rangeFormatting",
  "textDocument/onTypeFormatting",
  "textDocument/signatureHelp",
  "textDocument/prepareCallHierarchy",
  "textDocument/prepareTypeHierarchy",
]);

function isEmpty(result) {
  if (result === null || result === undefined) return true;
  if (Array.isArray(result)) return result.length === 0;
  if (Array.isArray(result.items)) return result.items.length === 0;
  if (Array.isArray(result.data)) return result.data.length === 0;
  return false;
}

async function main() {
  if (!existsSync(BUNDLE)) {
    console.error(`missing ${BUNDLE} — run: bun run build:standalone`);
    process.exit(2);
  }

  const dir = mkdtempSync(join(tmpdir(), "pike-standalone-sweep-"));
  const file = join(dir, "greeter.pike");
  writeFileSync(file, FIXTURE);
  const uri = `file://${file}`;

  // PIKE_LSP_STDIO must not leak in — that would mask a bundle which only
  // starts under the VSCode client's environment.
  const env = { ...process.env };
  delete env.PIKE_LSP_STDIO;

  const proc = spawn("bun", [BUNDLE, "--stdio"], { stdio: ["pipe", "pipe", "pipe"], env });
  const { request, notify } = createClient(proc);

  await request("initialize", {
    processId: process.pid,
    rootUri: `file://${dir}`,
    capabilities: CLIENT_CAPABILITIES,
    // The standalone contract: configuration arrives ONLY here. A capability
    // that needs workspace/configuration to work is a finding.
    initializationOptions: { pike: { diagnostics: { enable: true } } },
  });
  notify("initialized", {});
  notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "pike", version: 1, text: FIXTURE },
  });

  let errored = 0;
  let unexpectedlyEmpty = 0;
  for (const [method, params] of requests(uri)) {
    let status;
    let detail = "";
    try {
      const result = await request(method, params);
      if (!isEmpty(result)) {
        status = "ok";
      } else if (EMPTY_IS_LEGAL.has(method)) {
        status = "empty-ok";
      } else {
        status = "EMPTY";
        unexpectedlyEmpty++;
      }
    } catch (error) {
      status = "ERROR";
      detail = error.message;
      errored++;
    }
    console.log(`${status.padEnd(9)} ${method}${detail ? `  ${detail}` : ""}`);
  }

  proc.kill();
  console.log(`\n${errored} errored, ${unexpectedlyEmpty} unexpectedly empty, of ${requests(uri).length} capabilities`);
  process.exit(errored + unexpectedlyEmpty > 0 ? 1 : 0);
}

await main();
