import { describe, expect, test, beforeAll } from "bun:test";
import { CancellationToken, ResponseError } from "vscode-languageserver/node";
import { LSPErrorCodes } from "vscode-languageserver-protocol/lib/common/api";
import { TextDocument } from "vscode-languageserver-textdocument";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";
import { buildSemanticTokenData } from "../../server/src/features/navigationDocumentFeatures";
import {
  deltaEncodeTokens,
  produceSemanticTokens,
} from "../../server/src/features/semanticTokens";

/**
 * Semantic-token requests must distinguish document availability from token
 * content. Empty data is a successful semantic statement, so lifecycle races use
 * ContentModified instead of cache fallbacks or destructive empty responses.
 */
describe("semantic token lifecycle responses", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("builds same-version tokens directly when a reopened document is not indexed yet", async () => {
    const uri = "file:///semantic-reopen-cold-index.pike";
    const source = [
      "int main() {",
      "  string local = #\"hello",
      "world\";",
      "  write(local);",
      "}",
    ].join("\n");
    const doc = TextDocument.create(uri, "pike", 1, source);
    const expectedTable = buildSymbolTable(parse(source, uri), uri, doc.version, undefined, source);
    const expectedTokens = produceSemanticTokens(expectedTable);
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

    expect(expectedTokens.length).toBeGreaterThan(0);
    expect(data).toEqual(deltaEncodeTokens(expectedTokens));
  });

  test("does not answer stale tables with empty data", async () => {
    const uri = "file:///semantic-table-version-race.pike";
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
      expect(err).toBeInstanceOf(ResponseError);
      expect((err as ResponseError<unknown>).code).toBe(LSPErrorCodes.ContentModified);
    }
  });
});
