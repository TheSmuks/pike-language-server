/**
 * Pike Language Server — main entry point.
 *
 * Communicates over stdio. Provides documentSymbol, definition, references,
 * hover, and diagnostics (parse errors + Pike compilation).
 *
 * Architecture:
 * - `createPikeServer(connection)` — wires all handlers onto a connection.
 *   Used by tests to create an in-process server with PassThrough streams.
 * - Top-level `connection.listen()` — the production entry point over stdio.
 */

import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  Connection,
  Location as LspLocation,
  Range as LspRange,
  Position as LspPosition,
  DiagnosticSeverity,
  Diagnostic,
  Hover,
  MarkupKind,
  MarkupContent,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { initParser, parse } from "./parser";
import { getDocumentSymbols } from "./features/documentSymbol";
import { getParseDiagnostics } from "./features/diagnostics";
import {
  getDefinitionAt,
  getReferencesTo,
  type SymbolTable,
} from "./features/symbolTable";
import { WorkspaceIndex, ModificationSource } from "./features/workspaceIndex";
import { PikeWorker, type PikeDiagnostic } from "./features/pikeWorker";
import { renderAutodoc } from "./features/autodocRenderer";
import stdlibAutodocIndex from "./data/stdlib-autodoc.json";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Content-hash caching for Pike diagnostics
// ---------------------------------------------------------------------------

interface PikeCacheEntry {
  /** sha256 of the source content when this entry was computed. */
  contentHash: string;
  /** Pike diagnostics for this content. */
  diagnostics: PikeDiagnostic[];
  /** Timestamp when this entry was computed. */
  timestamp: number;
}

const pikeCache = new Map<string, PikeCacheEntry>();

const autodocCache = new Map<string, { xml: string; hash: string; timestamp: number }>();

// LRU cache eviction: 50 entries max, 25MB total
const CACHE_MAX_ENTRIES = 50;
const CACHE_MAX_BYTES = 25 * 1024 * 1024;
let cacheTotalBytes = 0;

function cacheSet(uri: string, entry: PikeCacheEntry): void {
  // Evict if at capacity
  if (pikeCache.size >= CACHE_MAX_ENTRIES) {
    cacheEvictOldest();
  }
  // Check byte budget
  const entrySize = JSON.stringify(entry).length;
  while (cacheTotalBytes + entrySize > CACHE_MAX_BYTES && pikeCache.size > 0) {
    cacheEvictOldest();
  }
  // Remove old entry if overwriting
  const old = pikeCache.get(uri);
  if (old) cacheTotalBytes -= JSON.stringify(old).length;
  pikeCache.set(uri, entry);
  cacheTotalBytes += entrySize;
}

function cacheEvictOldest(): void {
  // Find the oldest entry (smallest timestamp)
  let oldestKey: string | null = null;
  let oldestTime = Infinity;
  for (const [key, entry] of pikeCache) {
    if (entry.timestamp < oldestTime) {
      oldestTime = entry.timestamp;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    const old = pikeCache.get(oldestKey);
    if (old) cacheTotalBytes -= JSON.stringify(old).length;
    pikeCache.delete(oldestKey);
    autodocCache.delete(oldestKey);
  }
}

function cacheClear(): void {
  pikeCache.clear();
  autodocCache.clear();
  cacheTotalBytes = 0;
}

function computeContentHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

// ---------------------------------------------------------------------------
// Server factory — reusable for production and tests
// ---------------------------------------------------------------------------

export interface PikeServer {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  index: WorkspaceIndex;
  worker: PikeWorker;
  /** AutoDoc XML cache — exposed for testing. Keyed by URI. */
  autodocCache: Map<string, { xml: string; hash: string; timestamp: number }>;
}

/**
 * Wire all LSP handlers onto the given connection.
 * Does NOT call connection.listen() — the caller decides when to start.
 */
export function createPikeServer(connection: Connection): PikeServer {
  const documents = new TextDocuments(TextDocument);
  const worker = new PikeWorker();

  // Workspace index — initialized in onInitialize with the workspace root.
  // Starts with a placeholder path; overwritten when the client sends init.
  let index = new WorkspaceIndex({ workspaceRoot: "/tmp/unused" });

  /**
   * Get or build the symbol table for a document.
   * Uses the workspace index for lazy rebuild.
   */
  function getSymbolTable(uri: string): SymbolTable | null {
    const entry = index.getFile(uri);
    if (entry?.symbolTable) return entry.symbolTable;

    const doc = documents.get(uri);
    if (!doc) return null;

    try {
      const tree = parse(doc.getText());
      index.upsertFile(uri, doc.version, tree, doc.getText(), ModificationSource.DidChange);
      return index.getSymbolTable(uri);
    } catch (err) {
      connection.console.error(
        `symbolTable build failed: ${(err as Error).message}`,
      );
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Initialization
  // -----------------------------------------------------------------------

  connection.onInitialize((params: InitializeParams) => {
    const rootUri = params.rootUri ?? params.rootPath ?? "";
    const rootPath = rootUri.startsWith("file://") ? rootUri.slice(7) : rootUri;
    index = new WorkspaceIndex({ workspaceRoot: rootPath });

    return {
      capabilities: {
        textDocumentSync: {
          openClose: true,
          change: TextDocumentSyncKind.Full,
          save: { includeText: true },
        },
        documentSymbolProvider: true,
        definitionProvider: true,
        referencesProvider: true,
        hoverProvider: true,
      },
    } satisfies InitializeResult;
  });

  connection.onInitialized(async () => {
    try {
      await initParser();
      connection.console.log("Pike LSP: parser initialized");
    } catch (err) {
      connection.console.error(
        `Pike LSP: parser init failed: ${(err as Error).message}`,
      );
    }
  });

  // -----------------------------------------------------------------------
  // documentSymbol
  // -----------------------------------------------------------------------

  connection.onDocumentSymbol(async (params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    try {
      const tree = parse(doc.getText());

      // Report parse errors as diagnostics.
      const diagnostics = getParseDiagnostics(tree);
      connection.sendDiagnostics({ uri: doc.uri, diagnostics });

      // Return partial symbols — never crash on parse errors.
      return getDocumentSymbols(tree);
    } catch (err) {
      connection.console.error(
        `documentSymbol failed: ${(err as Error).message}`,
      );
      return [];
    }
  });

  // -----------------------------------------------------------------------
  // textDocument/definition
  // -----------------------------------------------------------------------

  connection.onDefinition(async (params) => {
    const table = getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    // Try same-file resolution first
    const decl = getDefinitionAt(
      table,
      params.position.line,
      params.position.character,
    );

    if (decl) {
      const loc: LspLocation = {
        uri: table.uri,
        range: {
          start: { line: decl.nameRange.start.line, character: decl.nameRange.start.character },
          end: { line: decl.nameRange.end.line, character: decl.nameRange.end.character },
        },
      };
      return loc;
    }

    // Try cross-file resolution
    const crossFile = index.resolveCrossFileDefinition(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    );

    if (crossFile) {
      const loc: LspLocation = {
        uri: crossFile.uri,
        range: {
          start: { line: crossFile.decl.nameRange.start.line, character: crossFile.decl.nameRange.start.character },
          end: { line: crossFile.decl.nameRange.end.line, character: crossFile.decl.nameRange.end.character },
        },
      };
      return loc;
    }

    return null;
  });

  // -----------------------------------------------------------------------
  // textDocument/references
  // -----------------------------------------------------------------------

  connection.onReferences(async (params) => {
    const table = getSymbolTable(params.textDocument.uri);
    if (!table) return [];

    // Try cross-file references
    const crossFileRefs = index.getCrossFileReferences(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    );

    if (crossFileRefs.length > 0) {
      return crossFileRefs.map(({ uri, ref }) => ({
        uri,
        range: {
          start: { line: ref.loc.line, character: ref.loc.character },
          end: { line: ref.loc.line, character: ref.loc.character + ref.name.length },
        },
      }));
    }

    // Fallback to same-file references
    const refs = getReferencesTo(
      table,
      params.position.line,
      params.position.character,
    );

    return refs.map((ref) => ({
      uri: table.uri,
      range: {
        start: { line: ref.loc.line, character: ref.loc.character },
        end: { line: ref.loc.line, character: ref.loc.character + ref.name.length },
      },
    }));
  });

  // -----------------------------------------------------------------------
  // textDocument/hover (decision 0002: three-source routing)
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // textDocument/hover (three-tier routing per decision 0011 §7)
  //
  // Tier 1: Workspace AutoDoc — XML from PikeExtractor (cached)
  // Tier 2: Stdlib — pre-computed index (hash lookup)
  // Tier 3: Tree-sitter — bare declared type
  // -----------------------------------------------------------------------

  const stdlibIndex = stdlibAutodocIndex as Record<string, { signature: string; markdown: string }>;

  connection.onHover(async (params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return null;

    const table = getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    // Find the declaration at or containing this position
    const decl = getDefinitionAt(
      table,
      params.position.line,
      params.position.character,
    );

    if (!decl) {
      // Try cross-file resolution for hover
      const crossFile = index.resolveCrossFileDefinition(
        params.textDocument.uri,
        params.position.line,
        params.position.character,
      );
      if (crossFile) {
        return formatHover(declForHover(crossFile.decl, crossFile.uri));
      }
      return null;
    }

    return formatHover(declForHover(decl, params.textDocument.uri));
  });

  /** Format a declaration into a Hover response. */
  function formatHover(info: HoverInfo | null): Hover | null {
    if (!info) return null;

    let value: string;
    if (info.isAutodoc && info.documentation) {
      // Autodoc already rendered as full markdown with signature
      value = info.documentation;
    } else {
      // Tier 3: bare tree-sitter signature
      const parts: string[] = [];
      parts.push("```pike");
      parts.push(info.signature);
      parts.push("```");
      if (info.documentation) {
        parts.push("");
        parts.push(info.documentation);
      }
      value = parts.join("\n");
    }

    const contents: MarkupContent = {
      kind: MarkupKind.Markdown,
      value,
    };

    return {
      contents,
      range: {
        start: { line: info.line, character: info.character },
        end: { line: info.line, character: info.character + info.name.length },
      },
    };
  }

  interface HoverInfo {
    name: string;
    signature: string;
    documentation: string;
    line: number;
    character: number;
    /** If true, documentation is already full markdown (from autodoc). */
    isAutodoc?: boolean;
  }

  /** Convert a Declaration to hover info. */
  function declForHover(
    decl: { name: string; kind: string; nameRange: { start: { line: number; character: number } }; range: { start: { line: number; character: number }; end: { line: number; character: number } } },
    uri: string,
  ): HoverInfo | null {
    const source = getSource(uri) ?? documents.get(uri)?.getText() ?? "";
    const lines = source.split("\n");

    // Extract the full declaration line as the signature
    const declLine = lines[decl.range.start.line] ?? "";
    const signature = declLine.trim().replace(/;$/, "");
    const formattedSig = formatSignature(decl.kind, decl.name, signature);

    // Tier 1: Workspace AutoDoc — check XML cache, render from XML
    const cachedAutodoc = autodocCache.get(uri);
    if (cachedAutodoc?.xml) {
      const rendered = renderAutodoc(cachedAutodoc.xml, decl.name, formattedSig);
      if (rendered) {
        return {
          name: decl.name,
          signature: rendered.signature || formattedSig,
          documentation: rendered.markdown,
          line: decl.nameRange.start.line,
          character: decl.nameRange.start.character,
          isAutodoc: true,
        };
      }
    }

    // Tier 2: Stdlib — hash-table lookup in pre-computed index
    // Try various FQN patterns: predef.Name, predef.Module.Name, etc.
    for (const fqn of buildStdlibLookupKeys(decl.name)) {
      const entry = stdlibIndex[fqn];
      if (entry) {
        return {
          name: decl.name,
          signature: entry.signature,
          documentation: entry.markdown,
          line: decl.nameRange.start.line,
          character: decl.nameRange.start.character,
          isAutodoc: true,
        };
      }
    }

    // Tier 3: Fall through to tree-sitter declared type
    return {
      name: decl.name,
      signature: formattedSig,
      documentation: "",
      line: decl.nameRange.start.line,
      character: decl.nameRange.start.character,
    };
  }

  /** Build candidate lookup keys for stdlib index. */
  function buildStdlibLookupKeys(name: string): string[] {
    return [
      `predef.${name}`,
      // Could add module-qualified keys in the future when we track
      // the import context of the symbol
    ];
  }

  /** Format a declaration kind + name + signature into hover text. */
  function formatSignature(kind: string, name: string, rawSignature: string): string {
    return rawSignature;
  }

  function getSource(uri: string): string | null {
    const doc = documents.get(uri);
    return doc ? doc.getText() : null;
  }

  // -----------------------------------------------------------------------
  // textDocument/didSave — Pike diagnostic pipeline (decision 0011)
  // -----------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (connection as any).onDidSave === "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (connection as any).onDidSave(async (params: { textDocument: { uri: string } }) => {
      const doc = documents.get(params.textDocument.uri);
      if (!doc) return;

    const source = doc.getText();
    const contentHash = computeContentHash(source);

    // Check cache
    const cached = pikeCache.get(doc.uri);
    if (cached && cached.contentHash === contentHash) {
      // Cache hit — republish cached diagnostics
      const lspDiagnostics = mergeDiagnostics(
        getParseDiagnostics(parse(source)),
        cached.diagnostics,
      );
      connection.sendDiagnostics({ uri: doc.uri, diagnostics: lspDiagnostics });
      return;
    }

    // Extract filepath from URI
    const filepath = doc.uri.startsWith("file://") ? doc.uri.slice(7) : doc.uri;

    try {
      const result = await worker.diagnose(source, filepath);
      
      // Handle timeout — surface as diagnostic to user
      if (result.timedOut) {
        const parseDiags = getParseDiagnostics(parse(source));
        const timeoutDiag: Diagnostic = {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          severity: DiagnosticSeverity.Warning,
          source: "pike-lsp",
          message: "Compilation timed out, will retry on next save.",
        };
        connection.sendDiagnostics({
          uri: doc.uri,
          diagnostics: [...parseDiags, timeoutDiag],
        });
        return;
      }

      // Update cache (LRU eviction handled by cacheSet)
      cacheSet(doc.uri, {
        contentHash,
        diagnostics: result.diagnostics,
        timestamp: Date.now(),
      });

      // Merge parse diagnostics with Pike diagnostics
      const parseDiags = getParseDiagnostics(parse(source));
      const lspDiagnostics = mergeDiagnostics(parseDiags, result.diagnostics);
      connection.sendDiagnostics({ uri: doc.uri, diagnostics: lspDiagnostics });

      // Extract AutoDoc XML alongside diagnostics
      const autodocHash = computeContentHash(source);
      const cachedAutodoc = autodocCache.get(doc.uri);
      if (!cachedAutodoc || cachedAutodoc.hash !== autodocHash) {
        worker.autodoc(source, filepath).then(result => {
          if (result.xml) {
            if (autodocCache.size >= CACHE_MAX_ENTRIES) {
              cacheEvictOldest();
            }
            autodocCache.set(doc.uri, { xml: result.xml, hash: autodocHash, timestamp: Date.now() });
          }
        }).catch(() => {}); // Non-critical: autodoc failure doesn't block
      }

    } catch (err) {
      connection.console.error(
        `Pike diagnose failed for ${doc.uri}: ${(err as Error).message}`,
      );
      // On failure, keep only parse diagnostics
      const parseDiags = getParseDiagnostics(parse(source));
      connection.sendDiagnostics({ uri: doc.uri, diagnostics: parseDiags });
    }
    });
  }

  /** Merge parse diagnostics (tree-sitter) with Pike compilation diagnostics. */
  function mergeDiagnostics(
    parseDiags: Diagnostic[],
    pikeDiags: PikeDiagnostic[],
  ): Diagnostic[] {
    const result = [...parseDiags];

    for (const pd of pikeDiags) {
      // Position mapping: Pike reports 1-based lines, LSP uses 0-based
      const line = pd.line - 1;

      let message = pd.message;
      if (pd.expected_type) {
        message += `\nExpected: ${pd.expected_type}`;
      }
      if (pd.actual_type) {
        message += `\nGot: ${pd.actual_type}`;
      }

      result.push({
        range: {
          start: { line, character: 0 },
          end: { line, character: 0 },
        },
        severity: pd.severity === "error"
          ? DiagnosticSeverity.Error
          : DiagnosticSeverity.Warning,
        source: "pike",
        message,
      });
    }

    return result;
  }

  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  connection.onShutdown(() => {
    index.clear();
    cacheClear();
    worker.stop();
  });

  // -----------------------------------------------------------------------
  // Text document handlers
  // -----------------------------------------------------------------------

  documents.onDidChangeContent(async (event) => {
    const doc = event.document;

    try {
      const tree = parse(doc.getText());

      // Update workspace index, invalidating dependents
      const invalidated = index.invalidateWithDependents(doc.uri);
      index.upsertFile(doc.uri, doc.version, tree, doc.getText(), ModificationSource.DidChange);

      if (invalidated.length > 1) {
        connection.console.log(
          `Invalidated ${invalidated.length} files (change in ${doc.uri})`,
        );
      }

      connection.sendDiagnostics({
        uri: doc.uri,
        diagnostics: getParseDiagnostics(tree),
      });
    } catch (err) {
      connection.console.error(
        `parse failed: ${(err as Error).message}`,
      );
    }
  });

  documents.onDidClose((event) => {
    index.removeFile(event.document.uri);
    pikeCache.delete(event.document.uri);
    connection.sendDiagnostics({
      uri: event.document.uri,
      diagnostics: [],
    });
  });

  documents.listen(connection);

  return { connection, documents, index, worker, autodocCache };
}

// ---------------------------------------------------------------------------
// Production entry point: stdio transport
// Only runs when this module is executed directly, not when imported by tests.
// ---------------------------------------------------------------------------

// @ts-ignore — Bun import.meta.main is true only when run directly
if (import.meta?.main) {
  const connection = createConnection(ProposedFeatures.all);
  const server = createPikeServer(connection);
  server.connection.listen();
}