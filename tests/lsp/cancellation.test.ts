/**
 * Cancellation token propagation tests (US-024).
 *
 * Tests that handlers respect CancellationToken and return early.
 * Uses raw JSON-RPC to control request IDs for precise cancellation.
 *
 * Methodology: send a request with a known ID, then immediately send
 * $/cancelRequest with that same ID before the server can respond.
 * The handler should return an empty/null result.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { PassThrough } from "node:stream";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc";
import { createConnection } from "vscode-languageserver/node";
import { createPikeServer } from "../../server/src/server";
import { initParser } from "../../server/src/parser";

// ---------------------------------------------------------------------------
// Raw JSON-RPC helpers
// ---------------------------------------------------------------------------

function writeRaw(stream: PassThrough, obj: object) {
  const body = JSON.stringify(obj);
  stream.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function readRaw(stream: PassThrough, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let bodyLen = 0;
    const timer = setTimeout(
      () => reject(new Error("raw response timeout")),
      timeoutMs,
    );
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      for (;;) {
        if (!bodyLen) {
          const idx = buf.indexOf("\r\n\r\n");
          if (idx === -1) break;
          const m = buf.substring(0, idx).match(/Content-Length: (\d+)/);
          if (m) bodyLen = parseInt(m[1]);
          buf = buf.substring(idx + 4);
        }
        if (bodyLen && buf.length >= bodyLen) {
          const body = buf.substring(0, bodyLen);
          buf = buf.substring(bodyLen);
          bodyLen = 0;
          clearTimeout(timer);
          stream.removeListener("data", onData);
          resolve(JSON.parse(body));
          return;
        }
        break;
      }
    };
    stream.on("data", onData);
  });
}

// ---------------------------------------------------------------------------
// Test fixture: raw client-server pair
// ---------------------------------------------------------------------------

let c2s: PassThrough;
let s2c: PassThrough;

beforeAll(async () => {
  c2s = new PassThrough();
  s2c = new PassThrough();
  const conn = createConnection(
    new StreamMessageReader(c2s),
    new StreamMessageWriter(s2c),
  );
  createPikeServer(conn);
  conn.listen();

  // Initialize
  writeRaw(c2s, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { processId: null, rootUri: null, capabilities: {} },
  });
  await readRaw(s2c);
  writeRaw(c2s, { jsonrpc: "2.0", method: "initialized", params: {} });
  await initParser();

  // Open a shared test document
  writeRaw(c2s, {
    jsonrpc: "2.0",
    method: "textDocument/didOpen",
    params: {
      textDocument: {
        uri: "file:///test/cancel.pike",
        languageId: "pike",
        version: 1,
        text: [
          "int x = 42;",
          "int main() {",
          "  return x;",
          "}",
        ].join("\n"),
      },
    },
  });
  // Wait for didOpen to be processed
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  // Graceful shutdown to avoid "Connection is closed" errors in later tests
  writeRaw(c2s, { jsonrpc: "2.0", id: 99999, method: "shutdown" });
  await readRaw(s2c, 1000).catch(() => {});
  c2s.destroy();
  s2c.destroy();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("US-024: Cancellation token propagation", () => {
  const uri = "file:///test/cancel.pike";

  test("definition handler returns empty when cancelled", async () => {
    // Send request then cancel immediately with the SAME request ID
    writeRaw(c2s, {
      jsonrpc: "2.0",
      id: 100,
      method: "textDocument/definition",
      params: {
        textDocument: { uri },
        position: { line: 0, character: 4 },
      },
    });
    writeRaw(c2s, {
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 100 },
    });

    const response = await readRaw(s2c);
    expect(response.id).toBe(100);
    // Cancelled definition returns null
    expect(response.result).toBeNull();
  });

  test("references handler returns empty when cancelled", async () => {
    writeRaw(c2s, {
      jsonrpc: "2.0",
      id: 200,
      method: "textDocument/references",
      params: {
        textDocument: { uri },
        position: { line: 0, character: 4 },
        context: { includeDeclaration: true },
      },
    });
    writeRaw(c2s, {
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 200 },
    });

    const response = await readRaw(s2c);
    expect(response.id).toBe(200);
    // Cancelled references returns empty array
    expect(response.result).toEqual([]);
  });

  test("hover handler returns null when cancelled", async () => {
    writeRaw(c2s, {
      jsonrpc: "2.0",
      id: 300,
      method: "textDocument/hover",
      params: {
        textDocument: { uri },
        position: { line: 0, character: 4 },
      },
    });
    writeRaw(c2s, {
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 300 },
    });

    const response = await readRaw(s2c);
    expect(response.id).toBe(300);
    // Cancelled hover returns null
    expect(response.result).toBeNull();
  });

  test("rename handler returns null when cancelled", async () => {
    writeRaw(c2s, {
      jsonrpc: "2.0",
      id: 400,
      method: "textDocument/rename",
      params: {
        textDocument: { uri },
        position: { line: 0, character: 4 },
        newName: "y",
      },
    });
    writeRaw(c2s, {
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 400 },
    });

    const response = await readRaw(s2c);
    expect(response.id).toBe(400);
    // Cancelled rename returns null
    expect(response.result).toBeNull();
  });

  test("semanticTokens handler returns empty data when cancelled", async () => {
    writeRaw(c2s, {
      jsonrpc: "2.0",
      id: 500,
      method: "textDocument/semanticTokens/full",
      params: {
        textDocument: { uri },
      },
    });
    writeRaw(c2s, {
      jsonrpc: "2.0",
      method: "$/cancelRequest",
      params: { id: 500 },
    });

    const response = await readRaw(s2c);
    expect(response.id).toBe(500);
    // Cancelled semantic tokens returns empty data
    expect(response.result).toEqual({ data: [] });
  });
});
