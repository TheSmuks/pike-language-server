import { describe, expect, test, beforeAll } from "bun:test";
import { CancellationToken } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";
import { buildSemanticTokenData } from "../../server/src/features/navigationDocumentFeatures";
import {
  deltaEncodeTokens,
  sliceSemanticTokens,
  produceSemanticTokens,
  type SemanticTokenRange,
} from "../../server/src/features/semanticTokens";

/**
 * Range semantic-token requests must use the same transient fallback as full
 * requests. VSCode may ask for range tokens after a workspace refresh; returning
 * an empty range response during a stale-index window clears visible coloring
 * even though a same-version full response was already known to be good.
 */
describe("semantic token range fallback", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("returns same-version cached range tokens when the table is temporarily unavailable", async () => {
    const uri = "file:///semantic-range-fallback.pike";
    const source = [
      "int main() {",
      "  string local = \"x\";",
      "  write(local);",
      "}",
    ].join("\n");
    const doc = TextDocument.create(uri, "pike", 7, source);
    const table = buildSymbolTable(parse(source, uri), uri, doc.version, undefined, source);
    const range: SemanticTokenRange = {
      start: { line: 1, character: 0 },
      end: { line: 3, character: 0 },
    };

    const cachedTokens = produceSemanticTokens(table);
    const cache = new Map([[uri, {
      version: doc.version,
      data: deltaEncodeTokens(cachedTokens),
      tokens: cachedTokens,
    }]]);
    const ctx = {
      documents: { get: (requestedUri: string) => requestedUri === uri ? doc : undefined },
      semanticTokensCache: cache,
      getSymbolTable: async () => null,
      predefBuiltins: {},
      stdlibIndex: {},
      debugTelemetry: false,
      connection: {},
    } as any;

    const data = await buildSemanticTokenData(ctx, uri, CancellationToken.None, range);
    expect(data.length).toBeGreaterThan(0);
    expect(data).toEqual(deltaEncodeTokens(sliceSemanticTokens(cachedTokens, range)));
  });

  test("returns same-version cached full tokens when a delayed refresh builds an empty table", async () => {
    const uri = "file:///semantic-full-empty-fallback.pike";
    const source = [
      "int main() {",
      "  string local = \"x\";",
      "  write(local);",
      "}",
    ].join("\n");
    const doc = TextDocument.create(uri, "pike", 3, source);
    const goodTable = buildSymbolTable(parse(source, uri), uri, doc.version, undefined, source);
    const emptyTable = buildSymbolTable(parse("// no symbols\n", uri), uri, doc.version, undefined, "// no symbols\n");
    const cachedTokens = produceSemanticTokens(goodTable);
    const cache = new Map([[uri, {
      version: doc.version,
      data: deltaEncodeTokens(cachedTokens),
      tokens: cachedTokens,
    }]]);
    const ctx = {
      documents: { get: (requestedUri: string) => requestedUri === uri ? doc : undefined },
      semanticTokensCache: cache,
      getSymbolTable: async () => emptyTable,
      predefBuiltins: {},
      stdlibIndex: {},
      debugTelemetry: false,
      connection: {},
    } as any;

    const data = await buildSemanticTokenData(ctx, uri, CancellationToken.None);
    expect(data.length).toBeGreaterThan(0);
    expect(data).toEqual(deltaEncodeTokens(cachedTokens));
  });

  test("does not return tokens from a table stale relative to the latest open document", async () => {
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
      semanticTokensCache: new Map(),
      getSymbolTable: async () => {
        currentDoc = docV2;
        return staleTable;
      },
      predefBuiltins: {},
      stdlibIndex: {},
      debugTelemetry: false,
      connection: {},
    } as any;

    const data = await buildSemanticTokenData(ctx, uri, CancellationToken.None);
    expect(data).toEqual([]);
    expect(ctx.semanticTokensCache.has(uri)).toBe(false);
  });
});
