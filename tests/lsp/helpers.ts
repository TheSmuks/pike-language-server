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
} from "vscode-jsonrpc/node";
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
      return origWrite(chunk, rest[0] as BufferEncoding, rest[1] as () => void);
    } else if (typeof rest[0] === "function") {
      return origWrite(chunk, rest[0] as () => void);
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
  /** Optional handler for workspace/semanticTokens/refresh requests. */
  semanticTokensRefreshHandler?: () => void;
  /** Advertise window.workDoneProgress capability and track progress notifications. */
  workDoneProgress?: boolean;
  /** Initialization options passed to the server during initialize. */
  initializationOptions?: Record<string, unknown>;
}

/** A single workDoneProgress notification received from the server. */
export interface ProgressEvent {
  token: string | number;
  value: { kind: string; title?: string; message?: string; percentage?: number };
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
  /** Progress notifications received (only populated when workDoneProgress enabled). */
  progressEvents: ProgressEvent[];
  /** Cancel a work-done-progress token by sending a cancel notification. */
  cancelProgress(token: string | number): void;
  /** Tear down both connections and streams. */
  teardown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createTestServer(options?: TestServerOptions): Promise<TestServer> {
  let nextDocVersion = 1;
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
      origError(args.map(String).join(" "));
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
  // The in-process client must model enough VSCode client behavior for
  // asynchronous server notifications to stay truthful in CI. When Pike is
  // unavailable the server asks VSCode to show a warning message; without this
  // handler, the JSON-RPC test client rejects the request and turns unrelated
  // tests red.
  client.onRequest("window/showMessageRequest", () => null);
  client.onRequest("workspace/semanticTokens/refresh", () => {
    options?.semanticTokensRefreshHandler?.();
    return null;
  });

  // Track workDoneProgress notifications when the capability is enabled.
  const progressEvents: ProgressEvent[] = [];
  if (options?.workDoneProgress) {
    client.onRequest("window/workDoneProgress/create", (params: { token: string | number }) => {
      return Promise.resolve();
    });
    client.onNotification("$/progress", (params: { token: string | number; value: ProgressEvent["value"] }) => {
      progressEvents.push({ token: params.token, value: params.value });
    });
  }

  client.listen();

  // Perform LSP initialization handshake
  await client.sendRequest("initialize", {
    processId: null,
    rootUri: options?.rootUri ?? null,
    capabilities: {
      window: options?.workDoneProgress ? { workDoneProgress: {} } : undefined,
    },
    initializationOptions: options?.initializationOptions,
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
    progressEvents,
    cancelProgress(token: string | number): void {
      client.sendNotification("$/cancelProgress", { token });
    },
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
      // Deliberately NOT sending the LSP `exit` notification. This server runs
      // in-process, so vscode-languageserver's built-in exit handler would call
      // process.exit(0) on the test runner itself — killing the suite mid-run
      // and reporting success. onShutdown (above) already does every cleanup
      // step, including ctx.worker.stop(); `exit` only kills the process.
      // Drain pending events before destroying streams to avoid
      // "Connection is closed" errors from in-flight notifications.
      await new Promise((r) => setTimeout(r, 50));
      c2s.destroy();
      s2c.destroy();
    },
  };
}

/**
 * Wait until the workspace index holds a symbol table for each given URI.
 *
 * `openDoc` returns as soon as the notification has been written; indexing the
 * file, and the files it inherits, happens afterwards on the server's own
 * schedule. A test that asserts a cross-file answer straight after opening is
 * racing that work — it passes on a machine where indexing wins and fails
 * where it does not, which is why the same test can pass locally and fail in
 * CI (or pass in a full run and fail run alone, when an earlier file has
 * already warmed the index).
 *
 * Polls the index itself rather than sleeping a fixed interval: it costs only
 * as long as the work actually takes, and it cannot pass by luck the way a
 * `setTimeout(300)` can. Throws rather than returning on timeout, so a genuine
 * indexing regression fails loudly instead of becoming a null assertion later.
 */
export async function waitForIndexed(
  server: TestServer,
  uris: string[],
  timeoutMs = 5000,
): Promise<void> {
  const missing = () => uris.filter((u) => !server.server.index.getSymbolTable(u));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (missing().length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForIndexed: timed out after ${timeoutMs}ms; not indexed: ${missing().join(", ")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Wait until the workspace index holds a *file entry* for each given URI —
 * a weaker condition than waitForIndexed's "has a symbol table".
 *
 * `index.getFile(uri)` becomes non-undefined as soon as discovery or
 * dependency-closure indexing reaches a file, which is earlier than
 * `getSymbolTable(uri)` returns non-null: a file can be present as a stub or
 * a stale entry awaiting rebuild. Use this when the assertion under test only
 * needs the file to be *known* to the index (e.g. dependency-closure
 * discovery), not a populated symbol table. Prefer `waitForIndexed` whenever
 * the assertion actually reads symbols.
 */
export async function waitForFileEntry(
  server: TestServer,
  uris: string[],
  timeoutMs = 5000,
): Promise<void> {
  const missing = () => uris.filter((u) => !server.server.index.getFile(u));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (missing().length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForFileEntry: timed out after ${timeoutMs}ms; not present: ${missing().join(", ")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
