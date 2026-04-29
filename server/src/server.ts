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
import { resolveType, resolveMemberAccess, type TypeResolutionContext } from "./features/typeResolver";
import { WorkspaceIndex, ModificationSource } from "./features/workspaceIndex";
import {
  getRenameLocations,
  buildWorkspaceEdit,
  prepareRename,
  validateRenameName,
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

  const pikeCache = new Map<string, PikeCacheEntry>();
  const autodocCache = new Map<string, { xml: string; hash: string; timestamp: number }>();

  // LRU cache eviction: 50 entries max, 25MB total
  const CACHE_MAX_ENTRIES = 50;
  const CACHE_MAX_BYTES = 25 * 1024 * 1024;
  let cacheTotalBytes = 0;
  const AUTODOC_CACHE_MAX_BYTES = 5 * 1024 * 1024;
  let autodocCacheBytes = 0;

  function cacheSet(uri: string, entry: PikeCacheEntry): void {
    if (pikeCache.size >= CACHE_MAX_ENTRIES) {
      cacheEvictOldest();
    }
    const entrySize = JSON.stringify(entry).length;
    while (cacheTotalBytes + entrySize > CACHE_MAX_BYTES && pikeCache.size > 0) {
      cacheEvictOldest();
    }
    const old = pikeCache.get(uri);
    if (old) cacheTotalBytes -= JSON.stringify(old).length;
    pikeCache.set(uri, entry);
    cacheTotalBytes += entrySize;
  }

  function cacheEvictOldest(): void {
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
      const autodocEntry = autodocCache.get(oldestKey);
      if (autodocEntry) autodocCacheBytes -= autodocEntry.xml.length;
      autodocCache.delete(oldestKey);
    }
  }

  function cacheClear(): void {
    pikeCache.clear();
    autodocCache.clear();
    cacheTotalBytes = 0;
    autodocCacheBytes = 0;
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
    const initOpts = params.initializationOptions as { diagnosticMode?: string } | undefined;
    if (initOpts?.diagnosticMode) {
      const mode = initOpts.diagnosticMode;
      if (mode === "realtime" || mode === "saveOnly" || mode === "off") {
        diagnosticManager.setDiagnosticMode(mode);
      }
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
    const accessResult = resolveAccessDefinition(table, params.textDocument.uri, params.position.line, params.position.character);
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

    const result = prepareRename(table, params.position.line, params.position.character);
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
      const accessDecl = resolveAccessDeclaration(table, params.textDocument.uri, params.position.line, params.position.character);
      if (accessDecl) {
        return formatHover(declForHover(accessDecl.decl, accessDecl.uri));
      }

      return null;
    }

    return formatHover(declForHover(decl, params.textDocument.uri));
  });

  /** Shared core: resolve arrow/dot access to { decl, uri }. */
  function resolveAccessCore(
    table: SymbolTable,
    uri: string,
    line: number,
    character: number,
  ): { decl: Declaration; uri: string } | null {
    const ref = table.references.find(
      r => r.loc.line === line && r.loc.character === character &&
        (r.kind === 'arrow_access' || r.kind === 'dot_access'),
    );
    if (!ref) {
      return null;
    }


    const doc = documents.get(uri);
    if (!doc) return null;
    const tree = parse(doc.getText(), uri);
    if (!tree) return null;

    const node = tree.rootNode.descendantForPosition({ row: line, column: character });
    if (!node) return null;

    let postfixNode = node;
    while (postfixNode.parent && postfixNode.type !== 'postfix_expr') {
      postfixNode = postfixNode.parent;
    }
    if (postfixNode.type !== 'postfix_expr') return null;

    const children = postfixNode.children;
    let lhsNode = null;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if ((child.type === '->' || child.type === '.' || child.type === '->?' || child.type === '?->') &&
          i + 1 < children.length &&
          children[i + 1].startPosition.row === node.startPosition.row &&
          children[i + 1].startPosition.column === node.startPosition.column) {
        lhsNode = children[i - 1];
        break;
      }
    }
    if (!lhsNode) {
      return null;
    }


    const lhsName = lhsNode.text;
    const lhsRef = table.references.find(
      r => r.name === lhsName && r.resolvesTo !== null &&
        r.loc.line === lhsNode.startPosition.row &&
        r.loc.character === lhsNode.startPosition.column,
    );
    const lhsDecl = lhsRef
      ? table.declarations.find(d => d?.id === lhsRef.resolvesTo) ?? null
      : table.declarations.find(d => d.name === lhsName) ?? null;

    if (!lhsDecl) {
      return null;
    }


    const ctx: TypeResolutionContext = { table, uri, index, stdlibIndex };
    const targetDecl = resolveMemberAccess(lhsName, ref.name, lhsDecl, ctx);
    if (!targetDecl) return null;

    const targetUri = table.declarations.includes(targetDecl) ? uri : findDeclUri(targetDecl) ?? uri;
    return { decl: targetDecl, uri: targetUri };
  }

  /** Resolve arrow/dot access to a definition location. */
  function resolveAccessDefinition(
    table: SymbolTable, uri: string, line: number, character: number,
  ): LspLocation | null {
    const result = resolveAccessCore(table, uri, line, character);
    if (!result) return null;
    return {
      uri: result.uri,
      range: {
        start: { line: result.decl.nameRange.start.line, character: result.decl.nameRange.start.character },
        end: { line: result.decl.nameRange.end.line, character: result.decl.nameRange.end.character },
      },
    };
  }

  /** Resolve arrow/dot access to a declaration (for hover). */
  function resolveAccessDeclaration(
    table: SymbolTable, uri: string, line: number, character: number,
  ): { decl: Declaration; uri: string } | null {
    return resolveAccessCore(table, uri, line, character);
  }

  /** Find the URI of a declaration by searching the workspace index. */
  function findDeclUri(targetDecl: Declaration): string | null {
    for (const uri of index.getAllUris()) {
      const t = index.getSymbolTable(uri);
      if (t?.declarations.includes(targetDecl)) return uri;
    }
    return null;
  }

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
  // textDocument/completion (decision 0012)
  // -----------------------------------------------------------------------

  const completionCtx: CompletionContext = {
    index,
    stdlibIndex,
    predefBuiltins,
    uri: "", // overridden per-request
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
      completionCtx.uri = params.textDocument.uri;
      return getCompletions(table, tree, params.position.line, params.position.character, completionCtx);
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
          const entrySize = result.xml.length;
          // Evict until we have room under the autodoc byte ceiling
          while (autodocCacheBytes + entrySize > AUTODOC_CACHE_MAX_BYTES && autodocCache.size > 0) {
            // Find oldest autodoc entry
            let oldestKey: string | null = null;
            let oldestTime = Infinity;
            for (const [key, entry] of autodocCache) {
              if (entry.timestamp < oldestTime) {
                oldestTime = entry.timestamp;
                oldestKey = key;
              }
            }
            if (oldestKey) {
              const removed = autodocCache.get(oldestKey)!;
              autodocCacheBytes -= removed.xml.length;
              autodocCache.delete(oldestKey);
            } else break;
          }
          const old = autodocCache.get(doc.uri);
          if (old) autodocCacheBytes -= old.xml.length;
          autodocCache.set(doc.uri, { xml: result.xml, hash: autodocHash, timestamp: Date.now() });
          autodocCacheBytes += entrySize;
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