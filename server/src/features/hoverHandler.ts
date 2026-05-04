/**
 * Hover handler — three-tier routing per decision 0011 §7.
 *
 * Tier 1: Workspace AutoDoc — XML from PikeExtractor (cached)
 * Tier 2: Stdlib — pre-computed index (hash lookup)
 * Tier 3: Tree-sitter — bare declared type
 *
 * Extracted from server.ts to keep the server entry point under 500 lines.
 */

import type {
  Connection,
  CancellationToken,
  Hover,
  MarkupContent,
} from "vscode-languageserver/node";
import { MarkupKind } from "vscode-languageserver/node";
import type { TextDocuments } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { parse } from "../parser";
import { getDefinitionAt, type SymbolTable, type Declaration } from "./symbolTable";
import {
  resolveAccessDeclaration,
  type ResolutionContext,
} from "./accessResolver";
import type { PikeWorker } from "./pikeWorker";
import { renderAutodoc } from "./autodocRenderer";
import type { LRUCache } from "../util/lruCache";
import { stripScopeWrapper } from "../util/stripScope";
import type { WorkspaceIndex } from "./workspaceIndex";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface HoverContext {
  documents: TextDocuments<TextDocument>;
  index: WorkspaceIndex;
  worker: PikeWorker;
  getSymbolTable(uri: string): Promise<SymbolTable | null>;
  autodocCache: LRUCache<{ xml: string; hash: string; timestamp: number }>;
  stdlibIndex: Record<string, { signature: string; markdown: string }>;
  predefBuiltins: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface HoverInfo {
  name: string;
  signature: string;
  documentation: string;
  line: number;
  character: number;
  /** If true, documentation is already full markdown (from autodoc). */
  isAutodoc?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render a predef builtin type signature into a human-readable display form.
 *
 * Raw signatures from Pike look like:
 *   scope(0,function(mixed|void...:mixed))
 *   function(string,mixed...:string) | function(array,mixed...:array)
 *   scope(0,__attribute__("deprecated",function(mixed...:mixed)))
 *
 * This function strips scope/attribute wrappers, takes the first overload,
 * and extracts the inner parameter list.
 */
function renderPredefSignature(name: string, rawSig: string): string {
  let cleanSig = stripScopeWrapper(rawSig);
  // Remove attribute annotations for cleaner display
  cleanSig = cleanSig.replace(/__attribute__\("[^"]*",\s*/g, "");
  // Take the first overload for brevity
  const overloads = cleanSig.split(" | function");
  if (overloads.length > 1) overloads[0] += ")";
  const displaySig = overloads[0]
    .replace(/^function\(/, "")
    .replace(/\)$/, "");
  return `${name}(${displaySig})`;
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

function getSource(uri: string, documents: TextDocuments<TextDocument>): string | null {
  const doc = documents.get(uri);
  return doc ? doc.getText() : null;
}

/** Convert a Declaration to hover info. */
function declForHover(
  decl: {
    name: string;
    kind: string;
    nameRange: { start: { line: number; character: number } };
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
  },
  uri: string,
  ctx: HoverContext,
): HoverInfo | null {
  const source = getSource(uri, ctx.documents) ?? ctx.documents.get(uri)?.getText() ?? "";
  const lines = source.split("\n");

  // Extract declaration text from the tree-sitter node's actual range
  const startLine = decl.range.start.line;
  const endLine = decl.range.end.line;
  const startChar = decl.range.start.character;
  const endChar = decl.range.end.character;
  let raw: string;
  if (startLine === endLine) {
    raw = (lines[startLine] ?? "").slice(startChar, endChar);
  } else {
    const parts: string[] = [];
    for (let i = startLine; i <= endLine; i++) {
      const line = lines[i] ?? "";
      if (i === startLine) {
        parts.push(line.slice(startChar));
      } else if (i === endLine) {
        parts.push(line.slice(0, endChar));
      } else {
        parts.push(line);
      }
    }
    raw = parts.join("\n");
  }
  // Trim trailing semicolons, opening braces, and inline comments
  const signature = raw
    .trim()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/m, "")
    .replace(/\s*\{\s*$/, "")
    .replace(/\s*;\s*$/, "")
    .trim();

  // Tier 1: Workspace AutoDoc — check XML cache, render from XML
  const cachedAutodoc = ctx.autodocCache.get(uri);
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
  const entry = ctx.stdlibIndex[`predef.${decl.name}`];
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
  const builtinSig = ctx.predefBuiltins[decl.name];
  if (builtinSig) {
    return {
      name: decl.name,
      signature: renderPredefSignature(decl.name, builtinSig),
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

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the hover handler on the connection.
 */
export function registerHoverHandler(
  connection: Connection,
  ctx: HoverContext,
): void {
  /** Build a source-aware type inferrer using PikeWorker.typeof_(). */
  const makeTypeInferrer = (source: string): ((varName: string) => Promise<string | null>) => {
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

  const baseResolutionCtx: ResolutionContext = {
    documents: ctx.documents,
    index: ctx.index,
    stdlibIndex: ctx.stdlibIndex,
  };
  connection.onHover(async (params, token: CancellationToken) => {
    if (token.isCancellationRequested) return null;
    const doc = ctx.documents.get(params.textDocument.uri);
    if (!doc) return null;

    const table = await ctx.getSymbolTable(params.textDocument.uri);
    if (!table) return null;

    // Find the declaration at or containing this position
    const decl = getDefinitionAt(
      table,
      params.position.line,
      params.position.character,
    );

    if (!decl) {
      // Try cross-file resolution for hover
      const crossFile = await ctx.index.resolveCrossFileDefinition(
        params.textDocument.uri,
        params.position.line,
        params.position.character,
      );
      if (crossFile) {
        return formatHover(declForHover(crossFile.decl, crossFile.uri, ctx));
      }

      // Try arrow/dot access resolution for hover
      const hoverTree = parse(doc.getText(), params.textDocument.uri);
      const hoverResolutionCtx: ResolutionContext = {
        ...baseResolutionCtx,
        typeInferrer: makeTypeInferrer(doc.getText()),
      };
      const accessDecl = await resolveAccessDeclaration(
        hoverResolutionCtx,
        table,
        params.textDocument.uri,
        params.position.line,
        params.position.character,
        hoverTree,
      );
      if (accessDecl) {
        return formatHover(declForHover(accessDecl.decl, accessDecl.uri, ctx));
      }

      return null;
    }

    // Tier 4: PikeWorker typeof for untyped/mixed variables
    // Only for variables/parameters where declaredType is absent or 'mixed'.
    // Explicitly typed variables (int, string, Dog, etc.) skip entirely.
    const isVariableLike = decl.kind === "variable" || decl.kind === "parameter";
    const declType = (decl as Declaration).declaredType;
    const needsPikeTypeof =
      isVariableLike &&
      (!declType || declType === "mixed" || declType === "auto");
    if (needsPikeTypeof) {
      const source = doc.getText();
      try {
        const typeofResult = await ctx.worker.typeof_(source, decl.name, token);
        if (
          typeofResult.type &&
          typeofResult.type !== "mixed" &&
          !typeofResult.error
        ) {
          const baseHover = declForHover(decl, params.textDocument.uri, ctx);
          if (baseHover) {

          }
        }
      } catch {
        // Worker unavailable or timed out — fall through to tree-sitter hover
      }
    }

    return formatHover(declForHover(decl, params.textDocument.uri, ctx));
  });
}
