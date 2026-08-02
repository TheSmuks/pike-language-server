/**
 * Tests for registerFileWatchHandlers — file watcher and rename registration.
 *
 * vscode-languageserver mixes file-operation handlers (onDidRenameFiles,
 * onDidCreateFiles, onDidDeleteFiles) into `connection.workspace`, not onto
 * `connection` itself (see node_modules/vscode-languageserver/lib/common/
 * fileOperations.js and server.js). Registering against the wrong spot is a
 * silent no-op, not a type error, so it needs a test that actually checks
 * the handler landed.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { Connection } from "vscode-languageserver/node";
import { registerFileWatchHandlers } from "../../server/src/serverFileWatchHandler";
import type { ServerContext } from "../../server/src/serverContext";
import { createTestServer, waitForIndexed, type TestServer } from "./helpers";

// ---------------------------------------------------------------------------
// Registration — mock connection shaped like the real API, where
// onDidRenameFiles exists ONLY under connection.workspace.
// ---------------------------------------------------------------------------

function mockConnection(): { connection: Connection; renameRegistrations: () => number } {
  let renameRegistrations = 0;
  const connection = {
    onDidChangeWatchedFiles: () => {},
    workspace: {
      onDidRenameFiles: () => {
        renameRegistrations++;
      },
    },
  } as unknown as Connection;
  return { connection, renameRegistrations: () => renameRegistrations };
}

describe("registerFileWatchHandlers — registration", () => {
  test("registers the rename handler on connection.workspace", () => {
    const { connection, renameRegistrations } = mockConnection();

    registerFileWatchHandlers(connection, {} as unknown as ServerContext);

    expect(renameRegistrations()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Behavior — drive workspace/didRenameFiles through the real LSP harness and
// observe handleFileRenames' effect: the old URI's index entry is retired.
// ---------------------------------------------------------------------------

async function waitUntilNotIndexed(
  server: TestServer,
  uri: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (server.server.index.getSymbolTable(uri) === null) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitUntilNotIndexed: timed out after ${timeoutMs}ms for ${uri}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("registerFileWatchHandlers — workspace/didRenameFiles behavior", () => {
  let server: TestServer;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await server.teardown();
  });

  test("retires the old URI's index entry on rename", async () => {
    const oldUri = "file:///proj/rename-old.pike";
    const newUri = "file:///proj/rename-new.pike";

    server.openDoc(oldUri, "int x = 1;\n");
    await waitForIndexed(server, [oldUri]);

    server.client.sendNotification("workspace/didRenameFiles", {
      files: [{ oldUri, newUri }],
    });

    await waitUntilNotIndexed(server, oldUri);
  });
});
