/**
 * Source-level regression for semantic refresh lifecycle.
 *
 * VSCode already requests semantic tokens for opened and changed documents. The
 * server must index same-file changes, but it must not manufacture extra
 * workspace/semanticTokens/refresh rounds for plain typing because those races
 * can make VSCode ask while the index is stale.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("semantic tokens for opened files", () => {
  test("didOpen handler indexes without per-open semantic-token refresh", async () => {
    const source = readFileSync("server/src/serverDocumentHandler.ts", "utf8");

    expect(source).toContain("documents.onDidOpen");
    expect(source).toContain("handleDidOpen");
    expect(source).toContain("indexOpenedDocumentFast");
    expect(source).toContain("upsertBackgroundFile");
    expect(source).not.toContain("scheduleSemanticTokensRefresh");
  });

  test("semantic token requests use ContentModified for lifecycle unavailability", () => {
    const source = readFileSync("server/src/features/navigationDocumentFeatures.ts", "utf8");

    expect(source).toContain("LSPErrorCodes.ContentModified");
    expect(source).toContain("ResponseError");
    expect(source).not.toContain("getCachedSemanticTokenData");
  });

  test("semantic token requests wait for parser readiness on first open", () => {
    const source = readFileSync("server/src/features/navigationDocumentFeatures.ts", "utf8");

    expect(source).toContain("initParser");
    expect(source).toContain("isParserReady");
    expect(source).toContain("ensureParserReadyForSemanticTokens");
  });
});
