/**
 * Guard: the shipped tree-sitter highlight query must compile against the
 * bundled grammar.
 *
 * `queries/highlights.scm` is copied verbatim by Helix / Neovim users (see
 * docs/other-editors.md). It is NOT loaded by the LSP itself, so nothing else
 * catches it drifting out of sync with the grammar. It once did: after the
 * grammar was overhauled, the shipped query still referenced removed node types
 * (`call_expression`, `function_definition`, `prepreprocessor_directive`, …),
 * which makes tree-sitter reject the whole file — external editors got zero
 * highlighting. This test recreates that failure mode: constructing a Query
 * throws if any node type or field is unknown to the current grammar.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Query } from "web-tree-sitter";
import { initParser, getLanguage } from "../../server/src/parser";

const QUERY_PATH = resolve(import.meta.dir, "../../queries/highlights.scm");

describe("shipped highlights.scm compiles against the bundled grammar", () => {
  beforeAll(async () => {
    await initParser();
  });

  test("queries/highlights.scm has no invalid node types or fields", () => {
    const source = readFileSync(QUERY_PATH, "utf-8");
    const language = getLanguage();
    let query: Query | undefined;
    expect(() => {
      query = new Query(language, source);
    }).not.toThrow();
    query?.delete();
  });
});
