/**
 * PIKE_LSP_STDIO alone must start the server.
 *
 * server/src/main.ts documents two independent ways to opt into listening:
 * PIKE_LSP_STDIO=1 (what the VSCode client sets) or an explicit --stdio flag
 * (what every other LSP client passes). In practice createConnection() also
 * requires a transport flag in argv, so a caller that sets only the env var
 * — with no --stdio in argv — crashed with a fatal uncaughtException instead
 * of serving LSP. Every in-repo caller happens to pass --stdio too, which is
 * why this went unnoticed; a bare env var is still a documented, supported
 * signal and must work on its own.
 */

import { describe, test, expect } from "bun:test";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAIN_TS = resolve(ROOT, "server", "src", "main.ts");
const TIMEOUT_MS = 30000;

interface InitializeOutcome {
  ok: boolean;
  why?: string;
}

function initializeOverEnvVarOnly(): Promise<InitializeOutcome> {
  return new Promise((done) => {
    const env = { ...process.env };
    delete env.PIKE_LSP_STDIO;
    env.PIKE_LSP_STDIO = "1";

    const proc = spawn("bun", [MAIN_TS], { stdio: ["pipe", "pipe", "pipe"], env });
    let buf = Buffer.alloc(0);
    let stderr = "";

    const finish = (result: InitializeOutcome) => {
      clearTimeout(timer);
      proc.kill();
      done(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, why: `no initialize response in ${TIMEOUT_MS}ms` }),
      TIMEOUT_MS,
    );

    proc.on("error", (e) => finish({ ok: false, why: `spawn failed: ${e.message}` }));
    proc.on("exit", (code) =>
      finish({ ok: false, why: `exited (code ${code}) without responding${stderr ? `: ${stderr.trim().slice(0, 300)}` : ""}` }),
    );
    proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    proc.stdout?.on("data", (chunk: Buffer) => {
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
        return finish(msg.error ? { ok: false, why: JSON.stringify(msg.error) } : { ok: true });
      }
    });

    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { processId: null, rootUri: null, capabilities: {} },
    });
    proc.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
}

describe("PIKE_LSP_STDIO env var alone", () => {
  test("starts the server and answers initialize, with no --stdio in argv", async () => {
    const result = await initializeOverEnvVarOnly();
    expect(result.ok, result.why).toBe(true);
  }, TIMEOUT_MS + 5000);
});
