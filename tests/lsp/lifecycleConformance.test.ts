/**
 * Regression: LSP lifecycle rules must be enforced.
 *
 * The server tracked no lifecycle state at all, so:
 *  - a second `initialize` re-ran the whole sequence — rebuilding the index and
 *    respawning the worker — against a server already serving requests;
 *  - requests after `shutdown` were answered normally, and answering them
 *    respawned the Pike worker that shutdown had just killed, leaving an orphan
 *    process behind;
 *  - a request before `initialize` returned a null result rather than
 *    ServerNotInitialized.
 *
 * Verified over real stdio as well (the standalone bundle), since the guard
 * sits in the shared per-request hook rather than in any one handler.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { createTestServer, waitForFileEntry, type TestServer } from "./helpers";

const SRC = `int main() { return 0; }\n`;

describe("LSP lifecycle conformance", () => {
  let server: TestServer;
  let root: string;
  let uri: string;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "pike-lifecycle-"));
    const file = join(root, "main.pike");
    writeFileSync(file, SRC);
    uri = pathToFileURL(file).href;
    server = await createTestServer({ rootUri: pathToFileURL(root).href });
    server.openDoc(uri, SRC);
    await waitForFileEntry(server, [uri], 30000);
  });

  afterAll(async () => {
    await server.teardown();
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test("a second initialize is rejected", async () => {
    // createTestServer has already initialized this server.
    let error: string | null = null;
    try {
      await server.client.sendRequest("initialize", {
        processId: process.pid,
        rootUri: pathToFileURL(root).href,
        capabilities: {},
        initializationOptions: {},
      });
    } catch (err) {
      error = (err as Error).message;
    }
    expect(error, "a second initialize must not be accepted").not.toBeNull();
    expect(error).toContain("already initialized");
  });

  test("requests are served normally while running", async () => {
    // Guard the guard: the rejection above must be about lifecycle, not about
    // the server being broken.
    const hover = await server.client.sendRequest("textDocument/hover", {
      textDocument: { uri }, position: { line: 0, character: 5 },
    });
    expect(hover, "hover must work before shutdown").toBeDefined();
  });

  // Must run last: it puts the server into the shutdown state for good.
  test("requests after shutdown are rejected", async () => {
    await server.client.sendRequest("shutdown", {});

    let error: string | null = null;
    try {
      await server.client.sendRequest("textDocument/hover", {
        textDocument: { uri }, position: { line: 0, character: 5 },
      });
    } catch (err) {
      error = (err as Error).message;
    }
    expect(error, "a request after shutdown must be refused").not.toBeNull();
    expect(error).toContain("shutting down");
  });
});
