/**
 * In-process LSP test helpers.
 *
 * Creates a client–server pair connected via PassThrough streams.
 * No subprocess, no stdio — milliseconds per test.
 *
 * Usage:
 *   const { client, server, openDoc } = await createTestServer();
 *   const result = await client.sendRequest('textDocument/documentSymbol', { ... });
 *   await teardown();
 */

import { PassThrough } from "node:stream";
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  MessageConnection,
} from "vscode-jsonrpc";
import {
  Connection,
  createConnection,
  ProposedFeatures,
} from "vscode-languageserver/node";
import { createPikeServer, PikeServer } from "../../server/src/server";

// ---------------------------------------------------------------------------
// Silent stream — suppresses writes after destroy to avoid unhandled errors
// when the server has in-flight async writes during teardown.
// ---------------------------------------------------------------------------

export function createSilentStream(): PassThrough {
  const stream = new PassThrough();
  const origWrite = stream.write.bind(stream);
  const origDestroy = stream.destroy.bind(stream);
  let dead = false;

  stream.destroy = function (this: PassThrough, ...args: any[]) {
    dead = true;
    return origDestroy(...(args as [Error?]));
  };

  (stream as any).write = function (chunk: any, ...rest: any[]) {
    if (dead) {
      const cb = typeof rest[rest.length - 1] === "function"
        ? rest[rest.length - 1]
        : null;
      if (cb) (cb as (err: null) => void)(null);
      return false;
    }
    if (typeof rest[0] === "string" && typeof rest[1] === "function") {
      return origWrite(chunk, rest[0], rest[1]);
    } else if (typeof rest[0] === "function") {
      return origWrite(chunk, rest[0]);
    } else {
      return origWrite(chunk);
    }
  };

  return stream;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TestServerOptions {
  /** Workspace root URI (e.g., file:///path/to/dir). Defaults to null. */
  rootUri?: string | null;
}

export interface TestServer {
  /** Client-side JSON-RPC connection for sending requests. */
  client: MessageConnection;
  /** Server-side LSP connection and documents. */
  server: PikeServer;
  /** Open a text document on the server, returning the URI. */
  openDoc(uri: string, text: string, languageId?: string): string;
  /** Client-to-server stream for raw message injection. */
  c2s: PassThrough;
  /** Server-to-client stream for raw response reading. */
  s2c: PassThrough;
  /** Tear down both connections and streams. */
  teardown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let nextDocVersion = 1;

/**
 * Create an in-process LSP server with a connected client.
 *
 * The server is initialized (sends initialize + initialized) before returning.
 * The caller can immediately send requests.
 */
export async function createTestServer(options?: TestServerOptions): Promise<TestServer> {
  // Two silent PassThrough streams: client→server and server→client
  const c2s = createSilentStream();
  const s2c = createSilentStream();

  // Server side: reads from c2s, writes to s2c
  const serverConn: Connection = createConnection(
    new StreamMessageReader(c2s),
    new StreamMessageWriter(s2c),
  );

  // Suppress "Connection is closed" errors that occur during teardown.
  // These are expected when streams are destroyed while background tasks
  // (diagnostics, indexing) are still running.
  const origError = serverConn.console.error.bind(serverConn.console);
  serverConn.console.error = (...args: unknown[]) => {
    try {
      origError(...args);
    } catch {
      // Connection closed during teardown — swallow
    }
  };

  const server = createPikeServer(serverConn);
  serverConn.listen();

  // Client side: reads from s2c, writes to c2s
  const client = createMessageConnection(
    new StreamMessageReader(s2c),
    new StreamMessageWriter(c2s),
  );
  client.listen();

  // Perform LSP initialization handshake
  await client.sendRequest("initialize", {
    rootUri: options?.rootUri ?? null,
    capabilities: {},
  });
  // The initialized notification triggers parser init
  client.sendNotification("initialized", {});

  // Wait for onInitialized → initParser to complete.
  // initParser is idempotent — call it directly to ensure readiness
  // rather than relying on a timed sleep.
  const { initParser: ensureReady } = await import("../../server/src/parser");
  await ensureReady();

  return {
    client,
    server,
    c2s,
    s2c,
    openDoc(uri: string, text: string, languageId = "pike"): string {
      const version = nextDocVersion++;
      // Send didOpen through the client so TextDocuments picks it up
      client.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId, version, text },
      });
      return uri;
    },
    async teardown(): Promise<void> {
      // Best-effort shutdown — don't hang if server is already gone
      const shutdownPromise = client.sendRequest("shutdown").catch(() => {});
      await Promise.race([
        shutdownPromise,
        new Promise((r) => setTimeout(r, 500)),
      ]);
      try {
        client.sendNotification("exit");
      } catch {
        // ignore
      }
      // Drain pending events before destroying streams to avoid
      // "Connection is closed" errors from in-flight notifications.
      await new Promise((r) => setTimeout(r, 50));
      c2s.destroy();
      s2c.destroy();
    },
  };
}
