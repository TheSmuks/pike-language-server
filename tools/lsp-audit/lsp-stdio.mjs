/**
 * Minimal LSP client over a child process's stdio.
 *
 * Extracted from scripts/check-helix-lsp.mjs so the standalone audit sweep and
 * the Helix guard share one implementation of Content-Length framing rather
 * than two copies that can drift apart.
 *
 * Deliberately hand-rolled rather than using vscode-jsonrpc: the point of the
 * standalone surface is to speak to the server the way a non-VSCode editor
 * does, over a real pipe, without the library the VSCode client uses.
 */

/**
 * Wrap a spawned process in a JSON-RPC client.
 *
 * @param {import("node:child_process").ChildProcess} proc
 * @param {{timeoutMs?: number}} [options]
 */
export function createClient(proc, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20000;
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
        // Server-to-client request: answer null so the server is not left
        // waiting. A non-VSCode client that never replies can deadlock it.
        send({ jsonrpc: "2.0", id: msg.id, result: null });
      }
    }
  });

  /** Send a request and resolve its result, or reject on error/timeout. */
  function request(method, params) {
    const id = nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error("timed out")), timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send a notification. There is no reply to wait for. */
  function notify(method, params) {
    send({ jsonrpc: "2.0", method, params });
  }

  return { send, request, notify };
}
