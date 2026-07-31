/**
 * Go-to navigation handlers — definition, references, implementation.
 *
 * Extracted from navigationHandler.ts to keep file sizes under 500 lines.
 */

import {
  type Connection,
  type CancellationToken,
  type Location as LspLocation,
} from "vscode-languageserver/node";
import type { NavigationContext } from "./navigationHandler";
import type { ResolutionContext } from "./accessResolver";
import { parse } from "../parser";
import {
  getLocalDeclarationAt,
  declOccurrenceRangeAt,
  getDefinitionAt,
  getReferencesTo,
} from "./symbolTable";
import { resolveAccessDefinition, modulePathAtPosition } from "./accessResolver";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolveType, type TypeResolutionContext } from "./typeResolver";
import { findImplementations } from "./implementation";
import { resolveIncludeTarget } from "./navigationInclude";
import { prepareGlobalQuery } from "./workspaceResolution";
import { logInfo } from "../util/errorLog.js";

/**
 * Register go-to navigation handlers on the connection.
 */
export function registerGoToHandlers(
  connection: Connection,
  ctx: NavigationContext,
): void {
  const makeTypeInferrer = buildTypeInferrerFactory(ctx);
  // Getters, not value captures: registration runs before `initialize`
  // replaces ctx.index / ctx.stdlibIndex with the real instances. A value
  // capture here would freeze the empty placeholders into every request.
  const resolutionCtx: ResolutionContext = {
    documents: ctx.documents,
    get index() { return ctx.index; },
    get stdlibIndex() { return ctx.stdlibIndex; },
  };

  connection.onDefinition((params, token) =>
    handleDefinition(connection, ctx, resolutionCtx, makeTypeInferrer, params, token));

  // Pike has no separate declaration/definition split (no header prototypes),
  // so "Go to Declaration" resolves to the same target as "Go to Definition".
  connection.onRequest("textDocument/declaration", (params, token) =>
    handleDefinition(connection, ctx, resolutionCtx, makeTypeInferrer, params, token));

  connection.onRequest("textDocument/typeDefinition", (params, token) =>
    handleTypeDefinition(ctx, makeTypeInferrer, params, token));

  connection.onReferences((params, token) =>
    handleReferences(ctx, params, token));

  connection.onRequest("textDocument/implementation", (params, token) =>
    handleImplementation(connection, ctx, params, token));
}

/**
 * Handle textDocument/typeDefinition — jump from a variable/expression to the
 * class that defines its type.
 *
 * Resolves the declaration under the cursor, extracts its declared type name,
 * and resolves that type to a class declaration (same-file, qualified, or
 * cross-file via inherit/import) using the shared type resolver.
 */
async function handleTypeDefinition(
  ctx: NavigationContext,
  makeTypeInferrer: (source: string) => (varName: string) => Promise<string | null>,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
  token: CancellationToken,
): Promise<LspLocation | null> {
  if (token.isCancellationRequested) return null;

  const table = await ctx.getSymbolTable(params.textDocument.uri);
  if (!table) return null;

  const decl = getDefinitionAt(table, params.position.line, params.position.character);
  const typeName = decl?.declaredType ? extractTypeName(decl.declaredType) : null;
  if (!typeName) return null;

  const doc = ctx.documents.get(params.textDocument.uri);
  const typeCtx: TypeResolutionContext = {
    table,
    uri: params.textDocument.uri,
    index: ctx.index,
    stdlibIndex: ctx.stdlibIndex,
    typeInferrer: doc ? makeTypeInferrer(doc.getText()) : undefined,
    cache: new Map(),
  };

  const resolved = await resolveType(typeName, typeCtx);
  if (!resolved || token.isCancellationRequested) return null;
  return declToLspLocation(resolved.uri, resolved.decl);
}

/**
 * Extract a resolvable class name from a declared-type string.
 *
 * Handles `object(Foo)` wrappers and qualified names (`Stdio.File`, kept as-is
 * for the resolver). Bails on container/compound types (`array(...)`,
 * `mapping(...)`, unions with `|`, function types) where a single target class
 * is ambiguous — the resolver would reject them anyway.
 */
function extractTypeName(declaredType: string): string | null {
  let t = declaredType.trim();
  const objMatch = t.match(/^object\(([^)]+)\)$/);
  if (objMatch) t = objMatch[1].trim();
  // Reject anything with whitespace, remaining parens, or union operators —
  // only a bare (optionally dotted) identifier resolves to one class.
  if (t === "" || /[\s()|*]/.test(t)) return null;
  return t;
}

/** Build a source-aware type inferrer factory using PikeWorker.typeof_(). */
function buildTypeInferrerFactory(
  ctx: NavigationContext,
): (source: string) => (varName: string) => Promise<string | null> {
  return (source: string) => {
    return async (varName: string) => {
      try {
        const result = await ctx.worker.typeof_(source, varName);
        if (result.type && !result.error) return result.type;
      } catch {
        // Worker unavailable — fall through
      }
      return null;
    };
  };
}

/** Handle textDocument/definition requests. */
async function handleDefinition(
  _connection: Connection,
  ctx: NavigationContext,
  resolutionCtx: ResolutionContext,
  makeTypeInferrer: (source: string) => (varName: string) => Promise<string | null>,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
  token: CancellationToken,
): Promise<LspLocation | LspLocation[] | null> {
  if (token.isCancellationRequested) return null;

  const includeDoc = ctx.documents.get(params.textDocument.uri);
  if (includeDoc) {
    const includeResult = await resolveIncludeTarget(
      includeDoc, params.textDocument.uri,
      params.position.line, params.position.character,
      (pathText, isSystem) => ctx.index.resolveInclude(pathText, isSystem, params.textDocument.uri),
    );
    if (includeResult) return includeResult;
  }

  const table = await ctx.getSymbolTable(params.textDocument.uri);
  if (!table) return null;

  const decl = getDefinitionAt(table, params.position.line, params.position.character);
  if (decl) return resolveDeclLocation(decl, table, params);

  const crossFile = await ctx.index.resolveCrossFileDefinition(
    params.textDocument.uri, params.position.line, params.position.character,
  );
  if (crossFile) {
    if (token.isCancellationRequested) return null;
    return declToLspLocation(crossFile.uri, crossFile.decl);
  }

  const accessResult = await resolveAccessForDefinition(ctx, resolutionCtx, makeTypeInferrer, table, params);
  if (accessResult) return accessResult;

  const modulePathResult = await resolveModulePathTarget(ctx, table, includeDoc, params);
  if (modulePathResult) return modulePathResult;

  // Nothing above found a target, and the cursor is on a declaration's own
  // name. That happens on an inherit or import whose target does not resolve —
  // and the server hands out exactly this location as the definition when
  // asked from anywhere else in the file, so answering nothing here is only an
  // inconsistency with itself.
  const local = getLocalDeclarationAt(table, params.position.line, params.position.character);
  if (!local) return null;
  const occurrence = declOccurrenceRangeAt(local, params.position.line, params.position.character);
  return declToLspLocation(table.uri, occurrence ? { nameRange: occurrence } : local);
}

/**
 * Last-resort definition targets the earlier tiers cannot see:
 * - an inherit alias (`base` in `base::create()`) → the inherit declaration;
 * - a module/type path segment (`Util` in `.Util.double_it`, `Stdio` in
 *   `Stdio.File`) → the module's file;
 * - a stdlib class path (`String.Buffer`) → the source location the Pike
 *   worker's runtime resolve reports.
 */
async function resolveModulePathTarget(
  ctx: NavigationContext,
  table: import("./symbolTable").SymbolTable,
  doc: { getText(): string } | undefined,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
): Promise<LspLocation | null> {
  if (!doc) return null;
  const lines = doc.getText().split('\n');
  const path = modulePathAtPosition(lines, params.position.line, params.position.character);
  if (!path) return null;

  // Inherit alias: jump to the inherit declaration that binds it.
  if (!path.includes(".")) {
    const aliasDecl = table.declarations.find(
      d => d.kind === "inherit" && d.alias === path,
    );
    if (aliasDecl) return declToLspLocation(table.uri, aliasDecl);
  }

  const moduleUri = await ctx.index.resolveModule(path, params.textDocument.uri);
  // Directory modules without a module.pmod resolve to the directory itself,
  // which an editor cannot open — skip those.
  if (moduleUri && !moduleUri.endsWith("/")) {
    return {
      uri: moduleUri,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };
  }

  // Stdlib class the filesystem walk cannot reach (a class inside a file
  // module, e.g. String.Buffer): the worker's introspection knows its source.
  // C-implemented symbols report the path Pike was BUILT from (a foreign
  // machine), so only offer the target when the file exists here.
  if (!path.startsWith(".") && path.includes(".") && ctx.worker) {
    try {
      const resolved = await ctx.worker.resolve(path);
      if (resolved.resolved && resolved.source_file && existsSync(resolved.source_file)) {
        const line = Math.max(0, (resolved.source_line ?? 1) - 1);
        return {
          uri: pathToFileURL(resolved.source_file).href,
          range: { start: { line, character: 0 }, end: { line, character: 0 } },
        };
      }
    } catch { /* Worker unavailable — no target */ }
  }

  return null;
}

/** Resolve a local declaration to its LSP location(s). */
function resolveDeclLocation(
  decl: import("./symbolTable").Declaration,
  table: import("./symbolTable").SymbolTable,
  params: { position: { line: number; character: number } },
): LspLocation | LspLocation[] {
  const nr = decl.nameRange;
  const cursorOnDeclName = nr.start.line === params.position.line &&
    params.position.character >= nr.start.character &&
    params.position.character < nr.end.character;

  if (cursorOnDeclName && decl.kind !== "inherit" && decl.kind !== "import") {
    const refs = getReferencesTo(table, params.position.line, params.position.character);
    if (refs.length > 0) {
      return refs.map(ref => ({
        uri: table.uri,
        range: {
          start: { line: ref.loc.line, character: ref.loc.character },
          end: { line: ref.loc.line, character: ref.loc.character + ref.name.length },
        },
      }));
    }
  }

  return declToLspLocation(decl.sourceUri ?? table.uri, decl);
}

/** Convert a declaration to an LSP Location. */
function declToLspLocation(uri: string, decl: { nameRange: { start: { line: number; character: number }; end: { line: number; character: number } } }): LspLocation {
  return {
    uri,
    range: {
      start: { line: decl.nameRange.start.line, character: decl.nameRange.start.character },
      end: { line: decl.nameRange.end.line, character: decl.nameRange.end.character },
    },
  };
}

/** Try arrow/dot access resolution for go-to-definition. */
async function resolveAccessForDefinition(
  ctx: NavigationContext,
  resolutionCtx: ResolutionContext,
  makeTypeInferrer: (source: string) => (varName: string) => Promise<string | null>,
  table: import("./symbolTable").SymbolTable,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
): Promise<LspLocation | null> {
  const doc = ctx.documents.get(params.textDocument.uri);
  const accessTree = doc ? parse(doc.getText(), params.textDocument.uri) : undefined;
  const accessResolutionCtx: ResolutionContext = doc
    ? { ...resolutionCtx, typeInferrer: makeTypeInferrer(doc.getText()) }
    : resolutionCtx;
  return resolveAccessDefinition(
    accessResolutionCtx, table, params.textDocument.uri,
    params.position.line, params.position.character, accessTree,
  );
}

/** Handle textDocument/references requests. */
async function handleReferences(
  ctx: NavigationContext,
  params: { textDocument: { uri: string }; position: { line: number; character: number }; context?: { includeDeclaration?: boolean } },
  token: CancellationToken,
): Promise<LspLocation[]> {
  if (token.isCancellationRequested) return [];
  const table = await ctx.getSymbolTable(params.textDocument.uri);
  if (!table) return [];

  // Ensure the workspace is fully indexed for complete cross-file reference
  // results. In openFiles mode this triggers a one-time full scan with
  // progress and cancellation support (contracts/lsp-resource-state.md).
  await prepareGlobalQuery({
    connection: ctx.connection,
    index: ctx.index,
    workspaceRoot: ctx.index.workspaceRoot,
    cancellationToken: token,
  });
  if (token.isCancellationRequested) return [];

  const includeDeclaration = params.context?.includeDeclaration === true;

  const crossFileRefs = ctx.index.getCrossFileReferences(
    params.textDocument.uri, params.position.line, params.position.character,
  );
  if (crossFileRefs.length > 0) {
    return buildCrossFileRefResults(crossFileRefs, table, params, includeDeclaration);
  }

  // Fallback: for unresolved symbols in freshly-opened files, ask async cross-file
  // definition resolution (which can trigger on-demand indexing) then re-run
  // reference lookup anchored at the resolved declaration position.
  const crossFileDecl = await ctx.index.resolveCrossFileDefinition(
    params.textDocument.uri,
    params.position.line,
    params.position.character,
  );
  if (crossFileDecl) {
    const anchoredRefs = ctx.index.getCrossFileReferences(
      crossFileDecl.uri,
      crossFileDecl.decl.nameRange.start.line,
      crossFileDecl.decl.nameRange.start.character,
    );
    if (ctx.debugTelemetry) {
      logInfo(
        ctx.connection,
        `[telemetry] references cross-file-fallback uri=${params.textDocument.uri} targetUri=${crossFileDecl.uri} refs=${anchoredRefs.length}`,
      );
    }
    if (anchoredRefs.length > 0) {
      let results = anchoredRefs.map(({ uri, ref }) => ({
        uri,
        range: {
          start: { line: ref.loc.line, character: ref.loc.character },
          end: { line: ref.loc.line, character: ref.loc.character + ref.name.length },
        },
      }));
      if (includeDeclaration) {
        const declLoc = declToLspLocation(crossFileDecl.uri, crossFileDecl.decl);
        const duplicateDecl = results.some(
          r => r.uri === declLoc.uri &&
            r.range.start.line === declLoc.range.start.line &&
            r.range.start.character === declLoc.range.start.character,
        );
        if (!duplicateDecl) results.unshift(declLoc);
      }
      return results;
    }
  }

  return buildSameFileRefResults(table, params, includeDeclaration);
}

/** Build reference results from cross-file references. */
function buildCrossFileRefResults(
  crossFileRefs: Array<{ uri: string; ref: { loc: { line: number; character: number }; name: string } }>,
  table: import("./symbolTable").SymbolTable,
  params: { position: { line: number; character: number } },
  includeDeclaration: boolean,
): LspLocation[] {
  let results = crossFileRefs.map(({ uri, ref }) => ({
    uri,
    range: {
      start: { line: ref.loc.line, character: ref.loc.character },
      end: { line: ref.loc.line, character: ref.loc.character + ref.name.length },
    },
  }));
  if (includeDeclaration) {
    results = prependDeclIfNotDuplicate(results, table, params);
  }
  return results;
}

/** Build reference results from same-file references. */
function buildSameFileRefResults(
  table: import("./symbolTable").SymbolTable,
  params: { position: { line: number; character: number } },
  includeDeclaration: boolean,
): LspLocation[] {
  const refs = getReferencesTo(table, params.position.line, params.position.character);
  let results = refs.map(ref => ({
    uri: table.uri,
    range: {
      start: { line: ref.loc.line, character: ref.loc.character },
      end: { line: ref.loc.line, character: ref.loc.character + ref.name.length },
    },
  }));
  if (includeDeclaration) {
    results = prependDeclIfNotDuplicate(results, table, params);
  }
  return results;
}

/** Prepend the declaration location to results if it's not already present. */
function prependDeclIfNotDuplicate(
  results: LspLocation[],
  table: import("./symbolTable").SymbolTable,
  params: { position: { line: number; character: number } },
): LspLocation[] {
  // The cross-file inherit/import case answers null here — see
  // getLocalDeclarationAt. `includeDeclaration` still has a declaration to
  // include: the one the cursor is sitting on.
  const decl = getDefinitionAt(table, params.position.line, params.position.character)
    ?? getLocalDeclarationAt(table, params.position.line, params.position.character);
  if (!decl) return results;
  // On a renamed inherit, the alias is the declaration the cursor is on; the
  // path it renames is a different location entirely.
  const occurrence = declOccurrenceRangeAt(decl, params.position.line, params.position.character);
  const declLoc = declToLspLocation(table.uri, occurrence ? { nameRange: occurrence } : decl);
  const isDuplicate = results.some(
    r => r.range.start.line === declLoc.range.start.line &&
      r.range.start.character === declLoc.range.start.character,
  );
  if (!isDuplicate) results.unshift(declLoc);
  return results;
}

/** Handle textDocument/implementation requests. */
async function handleImplementation(
  connection: Connection,
  ctx: NavigationContext,
  params: { textDocument: { uri: string }; position: { line: number; character: number } },
  token: CancellationToken,
): Promise<Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }>> {
  if (token.isCancellationRequested) return [];

  // Implementations span the whole workspace — ensure complete results.
  await prepareGlobalQuery({
    connection, index: ctx.index,
    workspaceRoot: ctx.index.workspaceRoot, cancellationToken: token,
  });
  if (token.isCancellationRequested) return [];

  return findImplementations(ctx.index, params.textDocument.uri, params.position.line, params.position.character)
    .map(impl => ({ uri: impl.uri, range: impl.range }));
}
