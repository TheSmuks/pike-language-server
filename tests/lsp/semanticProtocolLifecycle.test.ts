import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { CancellationToken, ResponseError } from "vscode-languageserver/node";
import { LSPErrorCodes } from "vscode-languageserver-protocol/lib/common/api";
import { TextDocument } from "vscode-languageserver-textdocument";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";
import { buildSemanticTokenData } from "../../server/src/features/navigationDocumentFeatures";
import { createTestServer, type TestServer } from "./helpers";

function expectResponseError(err: unknown, code: number): void {
  expect(err).toBeInstanceOf(ResponseError);
  expect((err as ResponseError<unknown>).code).toBe(code);
}

describe("semantic token protocol lifecycle", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("stale same-file tables report ContentModified instead of destructive empty data", async () => {
    const uri = "file:///semantic-stale-table-protocol.pike";
    const sourceV1 = [
      "int main() {",
      "  string local = \"x\";",
      "  write(local);",
      "}",
    ].join("\n");
    const sourceV2 = [
      "int main() {",
      "    string local = \"x\";",
      "    write(local);",
      "}",
    ].join("\n");
    const docV1 = TextDocument.create(uri, "pike", 1, sourceV1);
    const docV2 = TextDocument.create(uri, "pike", 2, sourceV2);
    const staleTable = buildSymbolTable(parse(sourceV1, uri), uri, docV1.version, undefined, sourceV1);
    let currentDoc = docV1;
    const ctx = {
      documents: { get: (requestedUri: string) => requestedUri === uri ? currentDoc : undefined },
      upsertInFlight: new Map(),
      getSymbolTable: async () => {
        currentDoc = docV2;
        return staleTable;
      },
      predefBuiltins: {},
      stdlibIndex: {},
      debugTelemetry: false,
      connection: {},
    } as any;

    try {
      await buildSemanticTokenData(ctx, uri, CancellationToken.None);
      throw new Error("expected ContentModified");
    } catch (err) {
      expectResponseError(err, LSPErrorCodes.ContentModified);
    }
  });

  test("parse errors report ContentModified instead of destructive empty data", async () => {
    const uri = "file:///semantic-parse-error-protocol.pike";
    const source = "int main() {\n  string local = \"x\";\n  write(local);\n";
    const doc = TextDocument.create(uri, "pike", 2, source);
    const table = buildSymbolTable(parse(source, uri), uri, doc.version, undefined, source);
    const ctx = {
      documents: { get: (requestedUri: string) => requestedUri === uri ? doc : undefined },
      upsertInFlight: new Map(),
      getSymbolTable: async () => table,
      predefBuiltins: {},
      stdlibIndex: {},
      debugTelemetry: false,
      connection: {},
    } as any;

    try {
      await buildSemanticTokenData(ctx, uri, CancellationToken.None);
      throw new Error("expected ContentModified");
    } catch (err) {
      expectResponseError(err, LSPErrorCodes.ContentModified);
    }
  });

  test("cancelled semantic token requests report RequestCancelled", async () => {
    const uri = "file:///semantic-cancelled-protocol.pike";
    const doc = TextDocument.create(uri, "pike", 1, "int main() { return 0; }\n");
    const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) };
    const ctx = {
      documents: { get: (requestedUri: string) => requestedUri === uri ? doc : undefined },
      upsertInFlight: new Map(),
      getSymbolTable: async () => null,
      predefBuiltins: {},
      stdlibIndex: {},
      debugTelemetry: false,
      connection: {},
    } as any;

    try {
      await buildSemanticTokenData(ctx, uri, token as any);
      throw new Error("expected RequestCancelled");
    } catch (err) {
      expectResponseError(err, LSPErrorCodes.RequestCancelled);
    }
  });

  test("cold reopen still converges to non-empty tokens without a refresh fallback", async () => {
    const uri = "file:///semantic-reopen-cold-index-protocol.pike";
    const source = [
      "int main() {",
      "  string local = #\"hello",
      "world\";",
      "  write(local);",
      "}",
    ].join("\n");
    const doc = TextDocument.create(uri, "pike", 1, source);
    const ctx = {
      documents: { get: (requestedUri: string) => requestedUri === uri ? doc : undefined },
      upsertInFlight: new Map(),
      getSymbolTable: async () => null,
      predefBuiltins: {},
      stdlibIndex: {},
      debugTelemetry: false,
      connection: {},
    } as any;

    const data = await buildSemanticTokenData(ctx, uri, CancellationToken.None);

    expect(data.length).toBeGreaterThan(0);
  });
});

describe("semantic token refresh lifecycle over LSP", () => {
  let server: TestServer;
  let refreshCount = 0;

  beforeAll(async () => {
    server = await createTestServer({ semanticTokensRefreshHandler: () => { refreshCount += 1; } });
  });

  afterAll(async () => {
    await server.teardown();
  });

  test("plain same-file edit bursts do not request workspace semantic-token refresh", async () => {
    refreshCount = 0;
    const uri = server.openDoc("file:///semantic-refresh-count-guard.pike", [
      "int main() {",
      "  string local = \"x\";",
      "  write(local);",
      "}",
    ].join("\n"));

    for (let index = 0; index < 24; index += 1) {
      server.client.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: index + 2 },
        contentChanges: [{ text: [
          "int main() {",
          `  string local = \"x${index}\";`,
          "  write(local);",
          "}",
        ].join("\n") }],
      });
      try {
        const result = await server.client.sendRequest<{ data: number[] }>("textDocument/semanticTokens/full", {
          textDocument: { uri },
        });
        expect(result.data.length).toBeGreaterThan(0);
      } catch (err) {
        const code = (err as { code?: number }).code;
        expect([LSPErrorCodes.ContentModified, LSPErrorCodes.RequestCancelled]).toContain(code);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(refreshCount).toBe(0);
  });
});
