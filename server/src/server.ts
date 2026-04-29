/**
 * Pike Language Server — main entry point.
 *
 * Communicates over stdio. Provides documentSymbol, definition, references,
 * hover, completion, rename, and diagnostics (parse errors + Pike compilation).
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
  Hover,
  MarkupKind,
  MarkupContent,
  CompletionItem,
  CompletionList,
  CancellationToken,
  DidChangeWatchedFilesNotification,
  FileChangeType,
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { LRUCache } from "./util/lruCache";
import { initParser, parse, deleteTree, clearTreeCache } from "./parser";
import { getDocumentSymbols } from "./features/documentSymbol";
import { getParseDiagnostics } from "./features/diagnostics";
import {
  getDefinitionAt,
  getReferencesTo,
  type SymbolTable,
  type Declaration,
} from "./features/symbolTable";
import { getCompletions, type CompletionContext } from "./features/completion";
import { WorkspaceIndex, ModificationSource } from "./features/workspaceIndex";
import {
  resolveAccessDefinition,
  resolveAccessDeclaration,
  type ResolutionContext,
} from "./features/accessResolver";
import {
  getRenameLocations,
  buildWorkspaceEdit,
  prepareRename,
  validateRenameName,
  type ProtectedNames,
} from "./features/rename";
import { PikeWorker } from "./features/pikeWorker";
import { renderAutodoc } from "./features/autodocRenderer";
import {
  DiagnosticManager,
  type DiagnosticMode,
  type PikeCacheEntry,
  computeContentHash,
} from "./features/diagnosticManager";
import stdlibAutodocIndex from "./data/stdlib-autodoc.json";
import predefBuiltinIndex from "./data/predef-builtin-index.json";

const predefBuiltins: Record<string, string> = predefBuiltinIndex as Record<string, string>;

/**
 * Build the set of protected symbol names that cannot be renamed.
 * Combines predef builtins (283) and unqualified stdlib names (5,471 FQNs).
 */
function buildProtectedNames(
  stdlibAutodoc: Record<string, unknown>,
  predef: Record<string, string>,
): Set<string> {
  const names = new Set<string>();
  // Predef builtins: keys are short names (write, search, etc.)
  for (const name of Object.keys(predef)) {
    names.add(name);
  }
  // Stdlib: keys are FQNs (predef.Array.diff). Extract unqualified name.
  for (const fqn of Object.keys(stdlibAutodoc)) {
    const parts = fqn.split('.');
    const short = parts[parts.length - 1];
    names.add(short);
  }
  return names;
}

const protectedNames: Set<string> = buildProtectedNames(
  stdlibAutodocIndex as Record<string, unknown>,
  predefBuiltins,
);

// ---------------------------------------------------------------------------
// Server factory — reusable for production and tests
// ---------------------------------------------------------------------------

export interface PikeServer {
  connection: Connection;
  documents: TextDocuments<TextDocument>;
  index: WorkspaceIndex;
  worker: PikeWorker;
  /** AutoDoc XML cache — exposed for testing. Keyed by URI. */
  autodocCache: LRUCache<{ xml: string; hash: string; timestamp: number }>;
  /** Diagnostic manager — exposed for testing. */
  diagnosticManager: DiagnosticManager;
}

/**
 * Wire all LSP handlers onto the given connection.
 * Does NOT call connection.listen() — the caller decides when to start.
 */
export function createPikeServer(connection: Connection): PikeServer {
  const documents = new TextDocuments(TextDocument);
  const worker = new PikeWorker();

  // -----------------------------------------------------------------
  // Caches (local to this server instance)
  // -----------------------------------------------------------------

  interface AutodocEntry {
    xml: string;
    hash: string;
    timestamp: number;
  }

  const autodocCache = new LRUCache<AutodocEntry>({
    maxEntries: 50,
    maxBytes: 5 * 1024 * 1024,
    estimateSize: (entry) => entry.xml.length,
  });

  const pikeCache = new LRUCache<PikeCacheEntry>({
    maxEntries: 50,
    maxBytes: 25 * 1024 * 1024,
    estimateSize: (entry) => JSON.stringify(entry).length,
    onEvict(key) {
      // Coupled eviction: when a pike cache entry is evicted,
      // also evict the corresponding autodoc entry.
      autodocCache.delete(key);
    },
  });

  function cacheSet(uri: string, entry: PikeCacheEntry): void {
    pikeCache.set(uri, entry);
  }

  function cacheClear(): void {
    pikeCache.clear();
    autodocCache.clear();
  }
  // Workspace index — initialized in onInitialize with the workspace root.
  // Starts with a placeholder path; overwritten when the client sends init.
  let index = new WorkspaceIndex({ workspaceRoot: "/tmp/unused" });

  // DiagnosticManager — handles debouncing, supersession, priority queueing.
  // Mode defaults to realtime; can be overridden via initializationOptions.
  const diagnosticManager = new DiagnosticManager({
    worker,
    documents,
    connection,
    index,
    pikeCache,
    cacheSet,
  });
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
      const tree = parse(doc.getText(), uri);
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

  // Track whether the client supports dynamic file watcher registration
  let clientSupportsWatchedFiles = false;

  connection.onInitialize((params: InitializeParams) => {
    const rootUri = params.rootUri ?? params.rootPath ?? "";
    const rootPath = rootUri.startsWith("file://") ? rootUri.slice(7) : rootUri;
    clientSupportsWatchedFiles =
      params.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
    index = new WorkspaceIndex({ workspaceRoot: rootPath });
    diagnosticManager.setIndex(index);

    // Read diagnostic mode from initializationOptions
    const initOpts = params.initializationOptions as {
      diagnosticMode?: string;
      pikeBinaryPath?: string;
      diagnosticDebounceMs?: number;
      maxNumberOfProblems?: number;
    } | undefined;
    if (initOpts?.diagnosticMode) {
      const mode = initOpts.diagnosticMode;
      if (mode === "realtime" || mode === "saveOnly" || mode === "off") {
        diagnosticManager.setDiagnosticMode(mode);
      }
    }
    if (initOpts?.pikeBinaryPath) {
      worker.updateConfig({ pikeBinaryPath: initOpts.pikeBinaryPath });
    }

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
        renameProvider: { prepareProvider: true },
        hoverProvider: true,
        completionProvider: {
          triggerCharacters: ['.', '>', ':'],
        },
        workspace: {
          fileOperations: {
            didRename: { filters: [{ pattern: { glob: '**/*.pike' } }, { pattern: { glob: '**/*.pmod' } }] },
          },
        },
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

    // Register file watchers for .pike and .pmod files.
    // Enables notifications when files change externally
    // (git checkout, file creation/deletion outside the editor).
    // Only register if the client supports dynamic registration;
    // the test harness does not, and calling register() on it
    // causes an unhandled JSON-RPC error.
    if (clientSupportsWatchedFiles) {
      connection.client.register(
        DidChangeWatchedFilesNotification.type,
        {
          watchers: [
            { globPattern: '**/*.pike' },
            { globPattern: '**/*.pmod' },
          ],
        },
      ).catch(() => {
        // Registration may still fail (e.g., client rejects it)
      });
    }
  });

  connection.onDidChangeWatchedFiles((params) => {
    for (const event of params.changes) {
      const uri = event.uri;
      switch (event.type) {
        case FileChangeType.Created:
        case FileChangeType.Changed: {
          // Invalidate cached data so it gets re-indexed on next access
          index.removeFile(uri);
          pikeCache.delete(uri);
          autodocCache.delete(uri);
          break;
        }
        case FileChangeType.Deleted: {
          index.removeFile(uri);
          deleteTree(uri);
          pikeCache.delete(uri);
          autodocCache.delete(uri);
          diagnosticManager.onDidClose(uri);
          break;
        }
      }
    }
  });

  // -----------------------------------------------------------------------
  // documentSymbol
  // -----------------------------------------------------------------------

  connection.onDocumentSymbol(async (params) => {
    const doc = documents.get(params.textDocument.uri);
    if (!doc) return [];

    try {
      const tree = parse(doc.getText(), doc.uri);

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
    // Try arrow/dot access resolution (obj->member, Module.function)
    const accessResult = resolveAccessDefinition(resolutionCtx, table, params.textDocument.uri, params.position.line, params.position.character);
    if (accessResult) return accessResult;

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
  // textDocument/rename (decision 0016)
  // -----------------------------------------------------------------------

  connection.onPrepareRename(async (params) => {
    const table = getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    const result = prepareRename(table, params.position.line, params.position.character, protectedNames);
    if (!result) return null;

    return {
      range: {
        start: { line: result.line, character: result.character },
        end: { line: result.line, character: result.character + result.length },
      },
      placeholder: result.name,
    };
  });

  connection.onRenameRequest(async (params) => {
    const table = getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    // Validate new name
    const validationError = validateRenameName(params.newName);
    if (validationError) {
      // LSP spec: return null or throw. We return null — client shows error UI.
      return null;
    }

    const renameResult = getRenameLocations(
      table,
      params.textDocument.uri,
      params.position.line,
      params.position.character,
      index,
      protectedNames,
    );

    if (!renameResult) return null;

    // Don't rename if old name equals new name
    if (renameResult.oldName === params.newName) return null;

    return buildWorkspaceEdit(renameResult.locations, params.newName);
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

      // Try arrow/dot access resolution for hover
      const accessDecl = resolveAccessDeclaration(resolutionCtx, table, params.textDocument.uri, params.position.line, params.position.character);
      if (accessDecl) {
        return formatHover(declForHover(accessDecl.decl, accessDecl.uri));
      }

      return null;
    }

    return formatHover(declForHover(decl, params.textDocument.uri));
  });

  // Resolution context for access resolver
  const resolutionCtx: ResolutionContext = { documents, index, stdlibIndex };


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

    // Tier 1: Workspace AutoDoc — check XML cache, render from XML
    const cachedAutodoc = autodocCache.get(uri);
    if (cachedAutodoc?.xml) {
      const rendered = renderAutodoc(cachedAutodoc.xml, decl.name, signature);
      if (rendered) {
        return {
          name: decl.name,
          signature: rendered.signature || signature,
          documentation: rendered.markdown,
          line: decl.nameRange.start.line,
          character: decl.nameRange.start.character,
          isAutodoc: true,
        };
      }
    }

    // Tier 2: Stdlib — hash-table lookup in pre-computed index
    const entry = stdlibIndex[`predef.${decl.name}`];
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

    // Tier 2b: Predef builtins (C-level functions) — type signature lookup
    const builtinSig = predefBuiltins[decl.name];
    if (builtinSig) {
      // Clean up the raw type string for readability
      let cleanSig = builtinSig
        .replace(/^scope\(\d+,/, "")
        .replace(/\)$/, ""); // Remove trailing scope paren
      // Remove attribute annotations for cleaner display
      cleanSig = cleanSig.replace(/__attribute__\("[^"]*",\s*/g, "");
      // Take the first overload for brevity
      const overloads = cleanSig.split(" | function");
      if (overloads.length > 1) overloads[0] += ")";
      const displaySig = overloads[0]
        .replace(/^function\(/, "")
        .replace(/\)$/, "");
      return {
        name: decl.name,
        signature: `${decl.name}(${displaySig})`,
        documentation: `Type signature (from Pike runtime):\n\`${builtinSig}\``,
        line: decl.nameRange.start.line,
        character: decl.nameRange.start.character,
        isAutodoc: true,
      };
    }

    // Tier 3: Fall through to tree-sitter declared type
    return {
      name: decl.name,
      signature: signature,
      documentation: "",
      line: decl.nameRange.start.line,
      character: decl.nameRange.start.character,
    };
  }

  function getSource(uri: string): string | null {
    const doc = documents.get(uri);
    return doc ? doc.getText() : null;
  }

  // -----------------------------------------------------------------------
  // textDocument/completion (decision 0012)
  // -----------------------------------------------------------------------

  const completionCtx = {
    index,
    stdlibIndex,
    predefBuiltins,
  };

  connection.onCompletion(async (params, token: CancellationToken) => {
    // Check cancellation early — if a new keystroke already came in, bail
    if (token.isCancellationRequested) return { isIncomplete: false, items: [] };

    const doc = documents.get(params.textDocument.uri);
    if (!doc) return { isIncomplete: false, items: [] };

    const table = getSymbolTable(params.textDocument.uri);
    if (!table || token.isCancellationRequested) return { isIncomplete: false, items: [] };

    try {
      const tree = parse(doc.getText(), params.textDocument.uri);
      if (token.isCancellationRequested) return { isIncomplete: false, items: [] };
      return getCompletions(table, tree, params.position.line, params.position.character, { ...completionCtx, uri: params.textDocument.uri });
    } catch (err) {
      connection.console.error(`completion failed: ${(err as Error).message}`);
      return { isIncomplete: false, items: [] };
    }
  });

  // -----------------------------------------------------------------------
  // textDocument/didSave — delegate to DiagnosticManager (decision 0013)
  // -----------------------------------------------------------------------

  documents.onDidSave(async (event) => {
    const doc = event.document;

    // Delegate to DiagnosticManager (handles cache, diagnose, publish)
    await diagnosticManager.onDidSave(doc.uri);

    // Extract AutoDoc XML alongside diagnostics (non-critical)
    const source = doc.getText();
    const autodocHash = computeContentHash(source);
    const cachedAutodoc = autodocCache.get(doc.uri);
    if (!cachedAutodoc || cachedAutodoc.hash !== autodocHash) {
      const filepath = doc.uri.startsWith("file://") ? doc.uri.slice(7) : doc.uri;
      worker.autodoc(source, filepath).then(result => {
        if (result.xml) {
          autodocCache.set(doc.uri, { xml: result.xml, hash: autodocHash, timestamp: Date.now() });
        }
      }).catch(() => {}); // Non-critical
    }
  });


  // -----------------------------------------------------------------------
  // Shutdown
  // -----------------------------------------------------------------------

  connection.onShutdown(() => {
    diagnosticManager.dispose();
    index.clear();
    cacheClear();
    clearTreeCache();
    worker.stop();
  });

  // -----------------------------------------------------------------------
  // Text document handlers
  // -----------------------------------------------------------------------

  documents.onDidChangeContent(async (event) => {
    const doc = event.document;

    try {
      const tree = parse(doc.getText(), doc.uri);

      // Update workspace index, invalidating dependents
      const invalidated = index.invalidateWithDependents(doc.uri);
      index.upsertFile(doc.uri, doc.version, tree, doc.getText(), ModificationSource.DidChange);

      if (invalidated.length > 1) {
        connection.console.log(
          `Invalidated ${invalidated.length} files (change in ${doc.uri})`,
        );
      }
    } catch (err) {
      connection.console.error(
        `parse failed: ${(err as Error).message}`,
      );
    }

    // Delegate real-time diagnostics to DiagnosticManager
    // (publishes parse diagnostics immediately, debounces Pike diagnostics)
    diagnosticManager.onDidChange(doc.uri);
  });

  documents.onDidClose((event) => {
    const uri = event.document.uri;
    deleteTree(uri);
    index.removeFile(uri);
    pikeCache.delete(uri);
    diagnosticManager.onDidClose(uri);
  });

  documents.listen(connection);

  return { connection, documents, get index() { return index; }, worker, autodocCache, diagnosticManager };
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