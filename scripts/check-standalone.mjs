#!/usr/bin/env node
/**
 * Verifies the standalone bundle actually serves LSP over stdio.
 *
 * Guards the non-VSCode client path (Neovim, Helix): the bundle must be built
 * from main.ts (server.ts never listens by design) and must start when given
 * only --stdio, with no PIKE_LSP_STDIO in the environment.
 *
 * Run after `bun run build:standalone`.
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TIMEOUT_MS = 30000;

// Each case is the exact invocation a non-VSCode client would use.
const CASES = [
  { name: "documented command (bun server.js --stdio)", cmd: "bun", args: [`${ROOT}/standalone/server.js`, "--stdio"] },
  { name: "bin wrapper (pike-language-server)", cmd: `${ROOT}/bin/pike-language-server`, args: [] },
];

// PIKE_LSP_STDIO must not leak in — that would mask a bundle that only starts
// under the VSCode client's environment.
function cleanEnv() {
  const env = { ...process.env };
  delete env.PIKE_LSP_STDIO;
  return env;
}

function initialize({ cmd, args }) {
  return new Promise((done) => {
    const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: cleanEnv() });
    let buf = Buffer.alloc(0);
    let stderr = "";

    const finish = (result) => { clearTimeout(timer); proc.kill(); done(result); };
    const timer = setTimeout(() => finish({ ok: false, why: `no initialize response in ${TIMEOUT_MS}ms` }), TIMEOUT_MS);

    proc.on("error", (e) => finish({ ok: false, why: `spawn failed: ${e.message}` }));
    proc.on("exit", (code) => finish({ ok: false, why: `exited (code ${code}) without responding${stderr ? `: ${stderr.trim().slice(0, 200)}` : ""}` }));
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    // Drain every frame: the server may emit notifications (window/logMessage,
    // telemetry) before the initialize response, so only id === 1 is the answer.
    proc.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const sep = buf.indexOf("\r\n\r\n");
        if (sep < 0) return;
        const header = /Content-Length: (\d+)/.exec(buf.subarray(0, sep).toString());
        if (!header) return finish({ ok: false, why: "malformed LSP header" });
        const len = Number(header[1]);
        if (buf.length < sep + 4 + len) return;
        const msg = JSON.parse(buf.subarray(sep + 4, sep + 4 + len).toString());
        buf = buf.subarray(sep + 4 + len);
        if (msg.id !== 1) continue;
        const caps = msg?.result?.capabilities;
        if (!caps?.documentSymbolProvider) return finish({ ok: false, why: "initialize response lacks documentSymbolProvider" });
        return finish({ ok: true });
      }
    });

    const req = JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { processId: process.pid, rootUri: null, capabilities: {}, clientInfo: { name: "check-standalone" } },
    });
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(req)}\r\n\r\n${req}`);
  });
}

/**
 * The server must exit on the LSP `exit` notification. This can only be
 * verified against a real subprocess — the in-process test servers share the
 * runner's process, so `exit` would kill the test suite instead.
 */
function exitsOnShutdown() {
  return new Promise((done) => {
    const proc = spawn("bun", [`${ROOT}/standalone/server.js`, "--stdio"], { stdio: ["pipe", "pipe", "pipe"], env: cleanEnv() });
    let buf = Buffer.alloc(0);
    const finish = (result) => { clearTimeout(timer); proc.kill(); done(result); };
    const timer = setTimeout(() => finish({ ok: false, why: "did not exit within 15s of shutdown + exit" }), 15000);

    proc.on("exit", (code) => { clearTimeout(timer); done(code === 0 ? { ok: true } : { ok: false, why: `exited with code ${code}, want 0` }); });

    const send = (msg) => {
      const s = JSON.stringify(msg);
      proc.stdin.write(`Content-Length: ${Buffer.byteLength(s)}\r\n\r\n${s}`);
    };
    // Drain every frame: the server interleaves pike/log notifications with
    // responses, and several can arrive in a single chunk.
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
        if (msg.id === 1) send({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null });
        if (msg.id === 2) send({ jsonrpc: "2.0", method: "exit", params: null });
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: process.pid, rootUri: null, capabilities: {} } });
  });
}

let failed = false;
for (const c of CASES) {
  const { ok, why } = await initialize(c);
  console.log(ok ? `  PASS  ${c.name}` : `  FAIL  ${c.name} — ${why}`);
  if (!ok) failed = true;
}
const exitCheck = await exitsOnShutdown();
console.log(exitCheck.ok ? "  PASS  exits cleanly on shutdown + exit" : `  FAIL  exits cleanly on shutdown + exit — ${exitCheck.why}`);
if (!exitCheck.ok) failed = true;
process.exit(failed ? 1 : 0);
