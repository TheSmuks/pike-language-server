#!/usr/bin/env node
/**
 * Guards Helix LSP support against regression.
 *
 * Drives the standalone bundle using Helix 25.01's real client capabilities
 * (captured from helix.log) and asserts each feature returns actual results —
 * advertising a capability in `initialize` is not evidence it works.
 *
 * Pike-binary-dependent behaviour (diagnostics) is deliberately excluded so
 * this runs anywhere; scripts/check-standalone.mjs covers process startup.
 *
 * Run after `bun run build:standalone`.
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = mkdtempSync(join(tmpdir(), "pike-helix-"));
const FILE = join(DIR, "greeter.pike");
const URI = `file://${FILE}`;

// Fixture names avoid Pike stdlib/predef collisions (`name`, `count`, `size`,
// …): the rename guard rejects those by name, which would fail this check for
// reasons unrelated to Helix. See docs/other-editors.md.
const SRC = `class Greeter {
  string label;

  void create(string n) {
    label = n;
  }

  string greet(string who) {
    return sprintf("Hello %s from %s", who, label);
  }
}

int main(int argc, array argv) {
  Greeter g = Greeter("pike");
  write(g.greet("world") + "\\n");
  return 0;
}
`;
writeFileSync(FILE, SRC);
const lines = SRC.split("\n");

/** Position of `needle` in the source, plus an optional column offset. */
function at(needle, offset = 0) {
  for (let line = 0; line < lines.length; line++) {
    const character = lines[line].indexOf(needle);
    if (character >= 0) return { line, character: character + offset };
  }
  throw new Error(`fixture missing: ${needle}`);
}

// Helix 25.01.1's declared capabilities, verbatim from its own initialize.
const HELIX_CAPS = {
  general: { positionEncodings: ["utf-8", "utf-32", "utf-16"] },
  textDocument: {
    codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["", "quickfix", "refactor", "source"] } }, dataSupport: true, disabledSupport: true, isPreferredSupport: true, resolveSupport: { properties: ["edit", "command"] } },
    completion: { completionItem: { deprecatedSupport: true, insertReplaceSupport: true, resolveSupport: { properties: ["documentation", "detail", "additionalTextEdits"] }, snippetSupport: true, tagSupport: { valueSet: [1] } }, completionItemKind: {} },
    formatting: { dynamicRegistration: false },
    hover: { contentFormat: ["markdown"] },
    inlayHint: { dynamicRegistration: false },
    publishDiagnostics: { tagSupport: { valueSet: [1, 2] }, versionSupport: true },
    rename: { dynamicRegistration: false, honorsChangeAnnotations: false, prepareSupport: true },
    signatureHelp: { signatureInformation: { activeParameterSupport: true, documentationFormat: ["markdown"], parameterInformation: { labelOffsetSupport: true } } },
  },
  window: { workDoneProgress: true },
  workspace: { applyEdit: true, configuration: true, workspaceFolders: true, symbol: { dynamicRegistration: false }, workspaceEdit: { documentChanges: true } },
};

const env = { ...process.env };
delete env.PIKE_LSP_STDIO;

/**
 * Server under test. Defaults to the standalone bundle; PIKE_LSP_SERVER_CMD
 * (a JSON array, e.g. '["./pike-language-server","--stdio"]') points it at a
 * release artifact instead, so CI runs this same sweep against the binary, the
 * tarball, and the npm install rather than trusting that they resemble it.
 */
function serverCommand() {
  const override = process.env.PIKE_LSP_SERVER_CMD;
  if (!override) return ["bun", [`${ROOT}/standalone/server.js`, "--stdio"]];
  let parts;
  try {
    parts = JSON.parse(override);
  } catch {
    throw new Error(`PIKE_LSP_SERVER_CMD must be a JSON array, got: ${override}`);
  }
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error(`PIKE_LSP_SERVER_CMD must be a non-empty JSON array, got: ${override}`);
  }
  return [parts[0], parts.slice(1)];
}

const [cmd, cmdArgs] = serverCommand();
if (process.env.PIKE_LSP_SERVER_CMD) console.log(`  (server: ${cmd} ${cmdArgs.join(" ")})`);
const proc = spawn(cmd, cmdArgs, { stdio: ["pipe", "pipe", "pipe"], env });

let buf = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();

function send(msg) {
  const s = JSON.stringify(msg);
  proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
}

proc.stdout.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf("\r\n\r\n");
    if (sep < 0) return;
    const header = /Content-Length: (\d+)/.exec(buf.subarray(0, sep).toString());
    if (!header) return;
    const len = Number(header[1]);
    if (buf.length < sep + 4 + len) return;
    const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString());
    buf = buf.subarray(sep + 4 + len);
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.id !== undefined && msg.method) {
      send({ jsonrpc: "2.0", id: msg.id, result: null }); // server -> client request
    }
  }
});

function request(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("timed out")), 20000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const doc = { textDocument: { uri: URI } };
const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ ok: detail !== false, name, detail: detail === false ? "returned nothing" : String(detail) });
  } catch (e) {
    results.push({ ok: false, name, detail: e.message });
  }
}

proc.on("exit", (code) => {
  if (nextId <= 2) {
    console.error(`  FAIL  server exited (code ${code}) before responding to initialize`);
    process.exit(1);
  }
});

try {
  await request("initialize", {
    processId: process.pid,
    clientInfo: { name: "helix", version: "25.01.1" },
    rootPath: DIR,
    rootUri: `file://${DIR}`,
    workspaceFolders: [{ name: "fixture", uri: `file://${DIR}` }],
    capabilities: HELIX_CAPS,
  });
} catch (e) {
  console.error(`  FAIL  initialize: ${e.message}`);
  proc.kill();
  process.exit(1);
}
send({ jsonrpc: "2.0", method: "initialized", params: {} });
send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri: URI, languageId: "pike", version: 1, text: SRC } } });
await new Promise((r) => setTimeout(r, 3000));

await check("documentSymbol", async () => {
  const r = JSON.stringify((await request("textDocument/documentSymbol", doc)) ?? []);
  return r.includes("Greeter") && r.includes("main") ? "Greeter, main" : false;
});
await check("hover", async () => {
  const r = await request("textDocument/hover", { ...doc, position: at("g.greet", 3) });
  return r?.contents ? "has contents" : false;
});
await check("definition", async () => {
  const r = await request("textDocument/definition", { ...doc, position: at("g.greet", 3) });
  const hit = Array.isArray(r) ? r[0] : r;
  return hit ? `line ${(hit.range ?? hit.targetRange).start.line}` : false;
});
await check("references", async () => {
  const r = await request("textDocument/references", { ...doc, position: at("string label", 7), context: { includeDeclaration: true } });
  return r?.length ? `${r.length} refs` : false;
});
await check("completion (trigger '.')", async () => {
  const r = await request("textDocument/completion", { ...doc, position: at("g.greet", 2), context: { triggerKind: 2, triggerCharacter: "." } });
  const items = Array.isArray(r) ? r : (r?.items ?? []);
  return items.length ? `${items.length} items` : false;
});
await check("signatureHelp", async () => {
  const r = await request("textDocument/signatureHelp", { ...doc, position: at('g.greet("world")', 8), context: { triggerKind: 2, triggerCharacter: "(", isRetrigger: false } });
  return r?.signatures?.length ? "has signatures" : false;
});
await check("prepareRename + rename", async () => {
  const pos = at("string greet", 7);
  if (!(await request("textDocument/prepareRename", { ...doc, position: pos }))) return false;
  const r = await request("textDocument/rename", { ...doc, position: pos, newName: "salute" });
  const edits = r?.changes ? Object.values(r.changes).flat() : (r?.documentChanges ?? []);
  return edits.length ? `${edits.length} edits` : false;
});
await check("documentHighlight", async () => {
  const r = await request("textDocument/documentHighlight", { ...doc, position: at("string label", 7) });
  return r?.length ? `${r.length} ranges` : false;
});
await check("workspace/symbol", async () => {
  const r = await request("workspace/symbol", { query: "Greeter" });
  return r?.length ? `${r.length} symbols` : false;
});
await check("selectionRange", async () => {
  const r = await request("textDocument/selectionRange", { ...doc, positions: [at("string label", 7)] });
  return r?.length ? "ok" : false;
});
await check("formatting", async () => {
  const r = await request("textDocument/formatting", { ...doc, options: { tabSize: 2, insertSpaces: true } });
  return Array.isArray(r) ? `${r.length} edits` : false;
});
await check("inlayHint", async () => {
  const r = await request("textDocument/inlayHint", { ...doc, range: { start: { line: 0, character: 0 }, end: { line: lines.length - 1, character: 0 } } });
  return Array.isArray(r) ? `${r.length} hints` : false;
});
await check("codeAction", async () => {
  const pos = at("g.greet");
  const r = await request("textDocument/codeAction", { ...doc, range: { start: pos, end: pos }, context: { diagnostics: [] } });
  return Array.isArray(r) ? `${r.length} actions` : false;
});

for (const { ok, name, detail } of results) console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(26)} ${detail}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} Helix LSP features working`);
proc.kill();
process.exit(failed.length ? 1 : 0);
