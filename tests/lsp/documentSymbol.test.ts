import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import {
  StreamMessageReader,
  StreamMessageWriter,
  createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc";
import { createConnection } from "vscode-languageserver/node";
import { createPikeServer, type PikeServer } from "../../server/src/server";
import { readSnapshot } from "../../harness/src/snapshot";
import { listCorpusFiles, CORPUS_DIR, snapshotNameForFile } from "../../harness/src/runner";
import type { DocumentSymbol } from "../../server/src/features/documentSymbol";
import { SymbolKind } from "../../server/src/features/documentSymbol";

// ---------------------------------------------------------------------------
// In-process test server factory
// ---------------------------------------------------------------------------

let nextDocVersion = 1;

interface TestContext {
  client: MessageConnection;
  server: PikeServer;
  c2s: PassThrough;
  s2c: PassThrough;
}

async function createServer(): Promise<TestContext> {
  const c2s = new PassThrough();
  const s2c = new PassThrough();

  const serverConn = createConnection(
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
    rootUri: null,
    capabilities: {},
  });
  client.sendNotification("initialized", {});
  const { initParser: ensureReady } = await import("../../server/src/parser");
  await ensureReady();

  return { client, server, c2s, s2c };
}

function teardown(ctx: TestContext): void {
  ctx.c2s.destroy();
  ctx.s2c.destroy();
}

function openDoc(
  ctx: TestContext,
  uri: string,
  text: string,
  languageId = "pike",
): string {
  const version = nextDocVersion++;
  ctx.client.sendNotification("textDocument/didOpen", {
    textDocument: { uri, languageId, version, text },
  });
  return uri;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** LSP SymbolKind values that are tree-sitter-only (no Pike equivalent). */
const TS_ONLY_KINDS = new Set([SymbolKind.Module, SymbolKind.TypeParameter]);

/** Flatten nested DocumentSymbol[] into a flat list. */
function flattenSymbols(symbols: DocumentSymbol[]): DocumentSymbol[] {
  const result: DocumentSymbol[] = [];
  function walk(syms: DocumentSymbol[]) {
    for (const s of syms) {
      result.push(s);
      if (s.children) walk(s.children);
    }
  }
  walk(symbols);
  return result;
}

/** Get only top-level LSP symbol names (excluding TS-only kinds). */
function topLevelNames(symbols: DocumentSymbol[]): Set<string> {
  return new Set(
    symbols
      .filter((s) => !TS_ONLY_KINDS.has(s.kind))
      .map((s) => s.name),
  );
}

/** Get corpus file source text. */
function readCorpusSource(filename: string): string {
  return readFileSync(join(CORPUS_DIR, filename), "utf-8");
}


/** Build a file URI for a corpus file. */
function corpusUri(filename: string): string {
  return `file://${join(CORPUS_DIR, filename)}`;
}

/** Check that no two siblings (same parent) share a name, excluding TS-only kinds. */
function assertNoSiblingDuplicates(symbols: DocumentSymbol[]): void {
  const names = symbols
    .filter((s) => !TS_ONLY_KINDS.has(s.kind))
    .map((s) => s.name);
  const unique = new Set(names);
  expect(unique.size).toBe(names.length);
  // Recurse into children
  for (const s of symbols) {
    if (s.children && s.children.length > 0) {
      assertNoSiblingDuplicates(s.children);
    }
  }
}

// ---------------------------------------------------------------------------
// Corpus file list
// ---------------------------------------------------------------------------

const corpusFiles = listCorpusFiles();

interface CorpusEntry {
  filename: string;
  snapName: string;
  hasSymbols: boolean;
  isErrFile: boolean;
}

const entries: CorpusEntry[] = corpusFiles.map((f) => {
  const snap = readSnapshot(snapshotNameForFile(f));
  return {
    filename: f,
    snapName: snapshotNameForFile(f),
    hasSymbols: (snap?.symbols?.length ?? 0) > 0,
    isErrFile: (snap?.compilation?.exit_code ?? 0) !== 0,
  };
});

const withSymbols = entries.filter((e) => e.hasSymbols);
const errorFiles = entries.filter((e) => e.isErrFile);

// ---------------------------------------------------------------------------
// Corpus-wide: each file gets its own describe block
// ---------------------------------------------------------------------------

describe.each(entries)("documentSymbol: $filename", ({ filename }) => {
  let ctx: TestContext;
  let lspSymbols: DocumentSymbol[];
  let source: string;

  beforeAll(async () => {
    ctx = await createServer();
    source = readCorpusSource(filename);
    const uri = openDoc(ctx, corpusUri(filename), source);
    lspSymbols = await ctx.client.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    );
  });

  afterAll(() => teardown(ctx));

  test("returns an array", () => {
    expect(Array.isArray(lspSymbols)).toBe(true);
  });

  test("all ranges are within file bounds", () => {
    const lineCount = source.split("\n").length;
    for (const sym of flattenSymbols(lspSymbols)) {
      expect(sym.range.start.line).toBeGreaterThanOrEqual(0);
      expect(sym.range.start.character).toBeGreaterThanOrEqual(0);
      expect(sym.range.end.line).toBeGreaterThanOrEqual(0);
      expect(sym.range.end.character).toBeGreaterThanOrEqual(0);
      expect(sym.range.start.line).toBeLessThan(lineCount);
      expect(sym.range.end.line).toBeLessThan(lineCount);

      // selectionRange must be within range
      expect(sym.selectionRange.start.line).toBeGreaterThanOrEqual(
        sym.range.start.line,
      );
      expect(sym.selectionRange.end.line).toBeLessThanOrEqual(
        sym.range.end.line,
      );
    }
  });

  test("no duplicate sibling names (excluding Module/TypeParameter)", () => {
    assertNoSiblingDuplicates(lspSymbols);
  });

  test("each symbol has required LSP fields", () => {
    for (const sym of flattenSymbols(lspSymbols)) {
      expect(typeof sym.name).toBe("string");
      expect(sym.name.length).toBeGreaterThan(0);
      expect(typeof sym.kind).toBe("number");
      expect(sym.range).toBeDefined();
      expect(sym.range.start).toBeDefined();
      expect(sym.range.end).toBeDefined();
      expect(sym.selectionRange).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Files with Pike symbols: bidirectional name coverage
// ---------------------------------------------------------------------------

describe.each(withSymbols)(
  "documentSymbol cross-check: $filename",
  ({ filename, snapName }) => {
    let ctx: TestContext;
    let lspSymbols: DocumentSymbol[];
    let pikeNames: Set<string>;

    beforeAll(async () => {
      ctx = await createServer();
      const source = readCorpusSource(filename);
      const uri = openDoc(ctx, corpusUri(filename), source);
      lspSymbols = await ctx.client.sendRequest(
        "textDocument/documentSymbol",
        { textDocument: { uri } },
      );
      const snap = readSnapshot(snapName)!;
      pikeNames = new Set(snap.symbols.map((s) => s.name));
    });

    afterAll(() => teardown(ctx));

    test("every Pike class/function symbol exists in LSP top-level symbols", () => {
      const lspTopNames = topLevelNames(lspSymbols);
      for (const sym of readSnapshot(snapName)!.symbols) {
        if (sym.kind === "class" || sym.kind === "function") {
          expect(
            lspTopNames.has(sym.name),
            `${filename}: Pike ${sym.kind} "${sym.name}" not found in LSP symbols [${[...lspTopNames].join(", ")}]`,
          ).toBe(true);
        }
      }
    });

    test("every top-level LSP symbol name (non-Module/TypeParameter) exists in Pike snapshot", () => {
      const lspTopNames = topLevelNames(lspSymbols);
      for (const name of lspTopNames) {
        expect(
          pikeNames.has(name),
          `${filename}: LSP symbol "${name}" not found in Pike snapshot [${[...pikeNames].join(", ")}]`,
        ).toBe(true);
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Error files: must not crash the server
// ---------------------------------------------------------------------------

describe.each(errorFiles)(
  "documentSymbol error files: $filename",
  ({ filename }) => {
    let ctx: TestContext;
    let lspSymbols: DocumentSymbol[];

    beforeAll(async () => {
      ctx = await createServer();
      const source = readCorpusSource(filename);
      const uri = openDoc(ctx, corpusUri(filename), source);
      lspSymbols = await ctx.client.sendRequest(
        "textDocument/documentSymbol",
        { textDocument: { uri } },
      );
    });

    afterAll(() => teardown(ctx));

    test("returns a valid array (no crash)", () => {
      expect(Array.isArray(lspSymbols)).toBe(true);
    });
  },
);

// ---------------------------------------------------------------------------
// Canary: class-create.pike produces a deep symbol tree with children
// ---------------------------------------------------------------------------

describe("documentSymbol canary: class-create.pike", () => {
  let ctx: TestContext;
  let lspSymbols: DocumentSymbol[];

  beforeAll(async () => {
    ctx = await createServer();
    const source = readCorpusSource("class-create.pike");
    const uri = openDoc(ctx, corpusUri("class-create.pike"), source);
    lspSymbols = await ctx.client.sendRequest(
      "textDocument/documentSymbol",
      { textDocument: { uri } },
    );
  });

  afterAll(() => teardown(ctx));

  test("returns at least one class symbol with children", () => {
    const classes = lspSymbols.filter((s) => s.kind === SymbolKind.Class);
    expect(classes.length).toBeGreaterThanOrEqual(1);
    const withChildren = classes.filter(
      (s) => s.children && s.children.length > 0,
    );
    expect(withChildren.length).toBeGreaterThanOrEqual(1);
  });

  test("class symbols nest methods/variables as children", () => {
    const classes = lspSymbols.filter(
      (s) =>
        s.kind === SymbolKind.Class && s.children && s.children.length > 0,
    );
    for (const cls of classes) {
      const childKinds = new Set(cls.children!.map((c) => c.kind));
      const hasDecls =
        childKinds.has(SymbolKind.Function) ||
        childKinds.has(SymbolKind.Variable) ||
        childKinds.has(SymbolKind.Constant);
      expect(hasDecls).toBe(true);
    }
  });

  test("all Pike snapshot symbols present in LSP response", () => {
    const snap = readSnapshot("class-create")!;
    const lspNames = new Set(
      flattenSymbols(lspSymbols)
        .filter((s) => !TS_ONLY_KINDS.has(s.kind))
        .map((s) => s.name),
    );
    for (const sym of snap.symbols) {
      expect(lspNames.has(sym.name)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Determinism: same request 10 times produces identical results
// ---------------------------------------------------------------------------

describe("documentSymbol determinism", () => {
  let ctx: TestContext;
  let uri: string;
  const results: DocumentSymbol[][] = [];

  beforeAll(async () => {
    ctx = await createServer();
    const source = readCorpusSource("basic-types.pike");
    uri = openDoc(ctx, corpusUri("basic-types.pike"), source);

    for (let i = 0; i < 10; i++) {
      const result = await ctx.client.sendRequest(
        "textDocument/documentSymbol",
        { textDocument: { uri } },
      );
      results.push(result);
    }
  });

  afterAll(() => teardown(ctx));

  test("all 10 responses are structurally identical", () => {
    const reference = JSON.stringify(results[0]);
    for (let i = 1; i < results.length; i++) {
      expect(JSON.stringify(results[i])).toBe(reference);
    }
  });

  test("first response is a valid non-empty array", () => {
    expect(Array.isArray(results[0])).toBe(true);
    expect(results[0].length).toBeGreaterThan(0);
  });
});
