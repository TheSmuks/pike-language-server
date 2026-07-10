/**
 * Tests for C1: runtime member resolution fallback via PikeWorker.resolve().
 *
 * When a variable's declared type is a stdlib type the static index does not
 * cover (e.g. `Image.Image`), member-access completion falls back to the
 * worker-backed `memberResolver` to enumerate methods/constants.
 *
 * These are direct API tests of getCompletions() with a stubbed memberResolver
 * (no live Pike worker), so they run without Pike installed.
 */

import { describe, it, expect } from "bun:test";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable, wireInheritance } from "../../server/src/features/symbolTable";
import { getCompletions, type CompletionContext } from "../../server/src/features/completion";
import { WorkspaceIndex } from "../../server/src/features/workspaceIndex";
import type { ResolveResult } from "../../server/src/features/pikeWorker";
import stdlibAutodocIndex from "../../server/src/data/stdlib-autodoc.json";
import predefBuiltinIndex from "../../server/src/data/predef-builtin-index.json";

await initParser();

interface ResolverStub {
  ctx: CompletionContext;
  calls: string[];
}

/** Build a CompletionContext whose memberResolver records its calls. */
function makeCtxWithResolver(
  source: string,
  responses: Record<string, ResolveResult>,
  uri = "file:///test/resolve-fallback.pike",
): ResolverStub {
  const calls: string[] = [];
  const ctx: CompletionContext = {
    index: new WorkspaceIndex({ workspaceRoot: "/test" }),
    stdlibIndex: stdlibAutodocIndex as Record<string, { signature: string; markdown: string }>,
    predefBuiltins: predefBuiltinIndex as Record<string, string>,
    predefAutodoc: {},
    uri,
    source,
    memberResolver: async (typeName: string) => {
      calls.push(typeName);
      return responses[typeName] ?? null;
    },
  };
  return { ctx, calls };
}

function labels(result: { items: Array<{ label: string }> }): string[] {
  return result.items.map(i => i.label);
}

function colAfterArrow(src: string, lineIdx: number): number {
  const line = src.split("\n")[lineIdx];
  if (!line) throw new Error(`line ${lineIdx} not found`);
  return line.length;
}

describe("C1: runtime member resolution fallback", () => {

  it("fills members for a stdlib type missing from the static index", async () => {
    const src = [
      "void test() {",
      "  Image.Image img;",
      "  img->",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/img.pike", 1, undefined, src);
    wireInheritance(table);

    const { ctx, calls } = makeCtxWithResolver(src, {
      "Image.Image": {
        resolved: true,
        kind: "class",
        methods: [{ name: "paste" }, { name: "scale" }, { name: "`&" }],
        constants: [{ name: "GIF_FLAG" }],
      },
    });

    const result = await getCompletions(table, tree, 2, colAfterArrow(src, 2), ctx);
    const got = labels(result);

    expect(calls).toContain("Image.Image");
    expect(got).toContain("paste");
    expect(got).toContain("scale");
    expect(got).toContain("GIF_FLAG");
    // Operator overloads are not completable `->` members.
    expect(got).not.toContain("`&");
  });

  it("does not invoke the resolver when the static index covers the type", async () => {
    // Stdio.File has members in the static stdlib index, so the fast path
    // must satisfy the request without a worker round-trip.
    const src = [
      "void test() {",
      "  Stdio.File f;",
      "  f->",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/file.pike", 1, undefined, src);
    wireInheritance(table);

    const { ctx, calls } = makeCtxWithResolver(src, {});
    const result = await getCompletions(table, tree, 2, colAfterArrow(src, 2), ctx);
    const got = labels(result);

    expect(got).toContain("open");   // from the static index
    expect(calls).toHaveLength(0);    // resolver never consulted
  });

  it("degrades gracefully when the resolver returns null", async () => {
    const src = [
      "void test() {",
      "  Image.Image img;",
      "  img->",
      "}",
    ].join("\n");
    const tree = parse(src);
    const table = buildSymbolTable(tree, "file:///test/img-null.pike", 1, undefined, src);
    wireInheritance(table);

    const { ctx, calls } = makeCtxWithResolver(src, {}); // no response → null
    const result = await getCompletions(table, tree, 2, colAfterArrow(src, 2), ctx);

    expect(calls).toContain("Image.Image");
    expect(result.items).toHaveLength(0);
  });
});
