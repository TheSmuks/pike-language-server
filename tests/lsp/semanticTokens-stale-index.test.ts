import { describe, test, expect, beforeAll } from "bun:test";
import { TextDocument } from "vscode-languageserver-textdocument";
import { initParser, parse } from "../../server/src/parser";
import { getSymbolTable } from "../../server/src/serverContext";
import { WorkspaceIndex, ModificationSource } from "../../server/src/features/workspaceIndex";

/**
 * Semantic tokens are computed from the workspace symbol table. The open
 * document is authoritative: if the index has version N but the editor has
 * version N+1, returning the stale table causes old ranges to be cached under
 * the new document version. In VSCode that paints partial words after rapid
 * edits, e.g. only `th` in `throw` keeps the semantic color.
 */
describe("semantic token source table freshness", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("getSymbolTable rebuilds stale indexed table for open document version", async () => {
    const uri = "file:///semantic-token-stale-index.pike";
    const sourceV1 = "int main() {\n  throw(({\"x\"}));\n}\n";
    const sourceV2 = "int main() {\n    throw(({\"x\"}));\n}\n";

    const index = new WorkspaceIndex({ workspaceRoot: "/tmp" });
    await index.upsertFile(
      uri,
      1,
      parse(sourceV1, uri),
      sourceV1,
      ModificationSource.DidChange,
    );

    const documentV2 = TextDocument.create(uri, "pike", 2, sourceV2);
    const ctx = {
      documents: { get: (requestedUri: string) => requestedUri === uri ? documentV2 : undefined },
      index,
      upsertInFlight: new Map<string, Promise<unknown>>(),
      connection: {},
    } as any;

    const table = await getSymbolTable(ctx, uri);
    expect(table).not.toBeNull();
    expect(table!.version).toBe(2);

    const throwReference = table!.references.find((ref) => ref.name === "throw");
    expect(throwReference).toBeDefined();
    expect(throwReference!.loc.line).toBe(1);
    expect(throwReference!.loc.character).toBe(4);
  });
});
