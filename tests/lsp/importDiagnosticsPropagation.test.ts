/**
 * Import-chain diagnostics: an importer's compile must see the imported
 * workspace .pmod the way the real `pike` binary does with the workspace on
 * its module path (`pike -M <workspaceRoot>` — the oracle for every
 * expectation below):
 *
 *  - intact lib.pmod            → importer compiles clean (no spurious
 *                                 "Module is neither mapping nor object")
 *  - no-op edit of lib.pmod     → propagated re-diagnose stays clean
 *  - breaking edit (unsaved)    → propagated re-diagnose reports the real
 *                                 "Undefined identifier label."
 *  - revert                     → clean again
 *
 * The breaking-edit phase exercises the live-buffer overlay: the edit is
 * didChange only (never written to disk), so a worker that compiles the
 * dependency from disk would wrongly stay clean.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { PassThrough } from "node:stream";
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  createConnection,
  DiagnosticSeverity,
  type Connection,
} from "vscode-languageserver/node";
import { createPikeServer, type PikeServer } from "../../server/src/server";
import { createSilentStream } from "./helpers";
import { pikeAvailable } from "../helpers/pikeAvailable";

const TMP_DIR = resolve(import.meta.dir, "__import_prop_tmp__");
const DEBOUNCE_MS = 50;

const LIB_CONTENT = [
  "#pragma strict_types",
  "",
  'constant LIB_VALUE = "1.0";',
  "string label(string s) { return s; }",
  "",
  "int main() { return 0; }",
].join("\n");

const CONSUMER_CONTENT = [
  "#pragma strict_types",
  "",
  "import lib;",
  "",
  "string use() { return label(LIB_VALUE); }",
  "",
  "int main() { return 0; }",
].join("\n");

interface PublishedDiagnostic {
  severity?: number;
  message: string;
}

interface Publish {
  diagnostics: PublishedDiagnostic[];
}

interface ImportTestContext {
  client: MessageConnection;
  server: PikeServer;
  c2s: PassThrough;
  s2c: PassThrough;
  publishes: Map<string, Publish[]>;
  openDoc(path: string, text: string): string;
  changeDoc(uri: string, text: string): void;
  /** Wait for the (index+1)-th publish for a URI (0-based index). */
  waitForPublishAt(uri: string, index: number, timeoutMs?: number): Promise<Publish>;
  teardown(): Promise<void>;
}

async function createImportTestServer(): Promise<ImportTestContext> {
  const c2s = createSilentStream();
  const s2c = createSilentStream();

  const serverConn: Connection = createConnection(
    new StreamMessageReader(c2s),
    new StreamMessageWriter(s2c),
  );
  const server = createPikeServer(serverConn);
  serverConn.listen();

  const client = createMessageConnection(
    new StreamMessageReader(s2c),
    new StreamMessageWriter(c2s),
  );
  client.listen();

  await client.sendRequest("initialize", {
    processId: null,
    rootUri: `file://${TMP_DIR}`,
    capabilities: {},
    initializationOptions: { diagnosticMode: "realtime" },
  });
  client.sendNotification("initialized", {});

  const { initParser } = await import("../../server/src/parser");
  await initParser();

  server.diagnosticManager.setDebounceMs(DEBOUNCE_MS);

  const publishes = new Map<string, Publish[]>();
  client.onNotification(
    "textDocument/publishDiagnostics",
    (params: { uri: string; diagnostics: PublishedDiagnostic[] }) => {
      const list = publishes.get(params.uri) ?? [];
      list.push({ diagnostics: params.diagnostics });
      publishes.set(params.uri, list);
    },
  );

  let nextVersion = 1;
  return {
    client, server, c2s, s2c, publishes,
    openDoc(path: string, text: string): string {
      const uri = `file://${path}`;
      client.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: "pike", version: nextVersion++, text },
      });
      return uri;
    },
    changeDoc(uri: string, text: string): void {
      client.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: nextVersion++ },
        contentChanges: [{ text }],
      });
    },
    waitForPublishAt(uri: string, index: number, timeoutMs = 10_000): Promise<Publish> {
      return new Promise((resolvePromise, reject) => {
        const deadline = Date.now() + timeoutMs;
        const poll = () => {
          const list = publishes.get(uri) ?? [];
          if (list.length > index) return resolvePromise(list[index]);
          if (Date.now() > deadline) {
            return reject(new Error(
              `Timed out waiting for publish #${index + 1} on ${uri} (got ${list.length})`,
            ));
          }
          setTimeout(poll, 20);
        };
        poll();
      });
    },
    async teardown(): Promise<void> {
      const shutdownPromise = client.sendRequest("shutdown").catch(() => {});
      await Promise.race([shutdownPromise, new Promise((r) => setTimeout(r, 500))]);
      // No `exit` notification: in-process server; see tests/lsp/helpers.ts.
      c2s.destroy();
      s2c.destroy();
    },
  };
}

function errorsOf(publish: Publish): PublishedDiagnostic[] {
  return publish.diagnostics.filter((d) => d.severity === DiagnosticSeverity.Error);
}

describe.skipIf(!pikeAvailable)("import .pmod diagnostics propagation", () => {
  let ctx: ImportTestContext;

  beforeEach(async () => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(join(TMP_DIR, "lib.pmod"), LIB_CONTENT);
    writeFileSync(join(TMP_DIR, "consumer.pike"), CONSUMER_CONTENT);
    ctx = await createImportTestServer();
  });

  afterEach(async () => {
    await ctx.teardown();
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  });

  test("importer stays clean through no-op edit, errors on breaking edit, recovers on revert", async () => {
    const libUri = ctx.openDoc(join(TMP_DIR, "lib.pmod"), LIB_CONTENT);
    const consumerUri = ctx.openDoc(join(TMP_DIR, "consumer.pike"), CONSUMER_CONTENT);

    // Publish #1 is the immediate parse-only publish; #2 is the debounced
    // pike-backed verdict. Oracle: `pike -M <dir> consumer.pike` exits 0.
    const initial = await ctx.waitForPublishAt(consumerUri, 1);
    expect(errorsOf(initial)).toEqual([]);

    // The import edge must exist, or the propagation phases below are vacuous.
    expect(ctx.server.index.getDependents(libUri).has(consumerUri)).toBe(true);

    // --- No-op edit: trailing newline. Propagated re-diagnose stays clean. ---
    let mark = (ctx.publishes.get(consumerUri) ?? []).length;
    ctx.changeDoc(libUri, LIB_CONTENT + "\n");
    const afterNoop = await ctx.waitForPublishAt(consumerUri, mark);
    expect(errorsOf(afterNoop)).toEqual([]);

    // --- Breaking edit (unsaved): remove label(). Oracle: "Undefined
    // identifier label." — not "Module is neither mapping nor object". ---
    mark = (ctx.publishes.get(consumerUri) ?? []).length;
    ctx.changeDoc(libUri, LIB_CONTENT.replace("string label(string s) { return s; }", ""));
    const afterBreak = await ctx.waitForPublishAt(consumerUri, mark);
    const breakErrors = errorsOf(afterBreak);
    expect(breakErrors.length).toBeGreaterThan(0);
    expect(breakErrors.some((d) => d.message.includes("Undefined identifier label"))).toBe(true);
    expect(breakErrors.some((d) => d.message.includes("neither mapping nor object"))).toBe(false);

    // --- Revert: clean again. ---
    mark = (ctx.publishes.get(consumerUri) ?? []).length;
    ctx.changeDoc(libUri, LIB_CONTENT);
    const afterRevert = await ctx.waitForPublishAt(consumerUri, mark);
    expect(errorsOf(afterRevert)).toEqual([]);

    // The spurious message must never have been published at any point.
    const allConsumer = ctx.publishes.get(consumerUri) ?? [];
    for (const publish of allConsumer) {
      for (const diag of publish.diagnostics) {
        expect(diag.message).not.toContain("Module is neither mapping nor object");
      }
    }
  }, 30_000);
});
