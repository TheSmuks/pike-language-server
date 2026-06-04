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
  test("didOpen handler indexes and refreshes semantic tokens", async () => {
    const source = readFileSync("server/src/serverDocumentHandler.ts", "utf8");

    // didOpen should index immediately on the fast local path, then schedule
    // semantic token refresh. Full dependency resolution stays lazy so an
    // `inherit` cannot block first paint.
    expect(source).toContain("documents.onDidOpen");
    expect(source).toContain("handleDidOpen");
    expect(source).toContain("indexOpenedDocumentFast");
    expect(source).toContain("upsertBackgroundFile");
    expect(source).toContain("scheduleSemanticTokensRefresh");
  });

  test("parse errors preserve last good full semantic token response", () => {
    const source = readFileSync("server/src/features/navigationDocumentFeatures.ts", "utf8");

    expect(source).toContain("data.length === 0");
    expect(source).toContain("hasParseError(doc.getText(), uri)");
    expect(source).toContain("return cached.data");
  });
});
