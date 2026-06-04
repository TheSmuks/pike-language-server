/**
 * Source-level regression for semantic refresh on open.
 *
 * Visual coloring used to appear only after the first edit. That means the
 * change path refreshed semantic tokens, but the open path did not explicitly
 * do the same. Keep an explicit didOpen handler so opened files are indexed and
 * refreshed without requiring a user edit.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("semantic tokens for opened files", () => {
  test("document handlers refresh semantic tokens from the didOpen path", () => {
    const source = readFileSync("server/src/serverDocumentHandler.ts", "utf8");

    expect(source).toContain("documents.onDidOpen");
    expect(source).toContain("handleDidOpen");
    expect(source).toContain("scheduleOpenedDocumentSemanticTokensRefresh(ctx)");
    expect(source).toContain("[50, 250, 1000]");
  });
});
