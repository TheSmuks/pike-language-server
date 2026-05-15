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
import type { Tree, Node } from "web-tree-sitter";
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
import { readFileSync } from "node:fs";
import { renderAutodocLines } from "./autodocLineRenderer";

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
  if (doc) return doc.getText();
  // Cross-file: document not open in editor. Read from disk.
  if (uri.startsWith("file://")) {
    try {
      return readFileSync(uri.slice(7), "utf8");
    } catch {
      return null;
    }
  }
  return null;
}

/** Convert a cross-file resolved declaration to hover info. */
function crossFileHover(
  crossFile: { uri: string; decl: Declaration },
  ctx: HoverContext,
  /** Original hover request position — used for the response range. */
  requestPosition?: { line: number; character: number },
): Hover | null {
  const decl = crossFile.decl;

  // Synthesized implicit-class declarations (scopeId === -1) point at the
  // top of a .pike file. Extract the file-level autodoc comment instead of
  // trying to build a signature from the zero-width range.
  if (decl.scopeId === -1) {
    return fileLevelHover(crossFile.uri, decl.name, ctx);
  }

  const info = declForHover(decl, crossFile.uri, ctx);
  if (!info) return null;

  // For cross-file hovers, the range should highlight the identifier in
  // the requesting document (where the user hovered), not the target
  // declaration's position in a different file.
  if (requestPosition) {
    info.line = requestPosition.line;
    info.character = requestPosition.character;
  }

  return formatHover(info);
}

/**
 * Build hover info for an implicit-class .pike file.
 * Reads the source, finds the first autodoc_comment, and renders it.
 */
function fileLevelHover(uri: string, name: string, ctx: HoverContext): Hover | null {
  // Tier 1: check autodoc XML cache
  const cachedAutodoc = ctx.autodocCache.get(uri);
  if (cachedAutodoc?.xml) {
    const rendered = renderAutodoc(cachedAutodoc.xml, name, `class ${name}`);
    if (rendered) {
      return formatHover({
        name,
        signature: rendered.signature || `class ${name}`,
        documentation: rendered.markdown,
        line: 0,
        character: 0,
        isAutodoc: true,
      });
    }
  }

  // Tier 2: extract autodoc_comment from tree-sitter parse.
  // getSource() already falls back to disk reads for non-open documents.
  const source = getSource(uri, ctx.documents);
  if (!source) {
    return formatHover({
      name,
      signature: `class ${name}`,
      documentation: "",
      line: 0,
      character: 0,
    });
  }

  const tree = parse(source, uri);
  if (tree) {
    // Collect consecutive autodoc_comment nodes from the top of the file.
    // Each //! line is a separate node. Blank //! lines separate paragraphs.
    const collectFileAutodoc = (root: Node): string[] => {
      const lines: string[] = [];
      for (const child of root.children) {
        if (child.type === "autodoc_comment") {
          // Strip //! prefix, keep empty lines as paragraph separators
          const text = child.text.replace(/^\/\/!\s?/, "");
          lines.push(text);
        } else if (child.type === "comment") {
          // Skip regular comments but keep going
          continue;
        } else {
          // Stop at first non-comment, non-whitespace node
          break;
        }
      }
      return lines;
    };
    const autodocLines = collectFileAutodoc(tree.rootNode);
    const nonEmpty = autodocLines.filter(l => l.length > 0);
    if (nonEmpty.length > 0) {
      const rendered = renderAutodocLines(autodocLines);
      if (rendered) {
        return formatHover({
          name,
          signature: `class ${name}`,
          documentation: rendered,
          line: 0,
          character: 0,
        });
      }
    }
  }

  return formatHover({
    name,
    signature: `class ${name}`,
    documentation: "",
    line: 0,
    character: 0,
  });
}
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
  // Trim trailing semicolons, opening braces, and inline comments.
  // For function/method declarations, strip the body: everything from
  // the first '{' onward (handles both single-line and multi-line bodies).
  const signature = raw
    .trim()
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/m, "")
    .replace(/\s*\{[\s\S]*$/, "")
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

  // Tier 2b: Extract //! autodoc from lines immediately above the declaration.
  // This handles cross-file hovers where the PikeExtractor XML cache isn't
  // populated. Collects consecutive //! lines above the declaration, grouping
  // them into paragraphs on blank //! separators.
  {
    const declLine = decl.nameRange.start.line;
    if (declLine > 0) {
      const autodocLines: string[] = [];
      let scanLine = declLine - 1;
      while (scanLine >= 0) {
        const lineText = (lines[scanLine] ?? "").trimEnd();
        if (lineText.endsWith("*/")) {
          // Block comment end — scan backwards for start
          const blockEnd = scanLine;
          let blockStart = scanLine;
          for (let bl = scanLine; bl >= 0; bl--) {
            if ((lines[bl] ?? "").includes("/*")) {
              blockStart = bl;
              break;
            }
          }
          scanLine = blockStart - 1;
          continue;
        }
        const match = lineText.match(/^\/\/!\s?(.*)/);
        if (match) {
          autodocLines.unshift(match[1]);
          scanLine--;
        } else if (lineText === "" || lineText.startsWith("//")) {
          // Blank line or regular comment — skip but keep scanning
          scanLine--;
        } else {
          break;
        }
      }
      // Split into paragraphs on blank //! lines, render autodoc markup
      const paragraphs: string[] = [];
      let current: string[] = [];
      for (const line of autodocLines) {
        if (line.length === 0) {
          if (current.length > 0) {
            paragraphs.push(current.join(" "));
            current = [];
          }
        } else {
          current.push(line);
        }
      }
      if (current.length > 0) paragraphs.push(current.join(" "));
      if (paragraphs.length > 0) {
        const rendered = renderAutodocLines(autodocLines);
        return {
          name: decl.name,
          signature: signature,
          documentation: rendered || paragraphs.join("\n\n"),
          line: decl.nameRange.start.line,
          character: decl.nameRange.start.character,
          isAutodoc: true,
        };
      }
    }
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
/**
 * Find the identifier token at a given position in the source.
 */
function identifierAtPosition(
  tree: Tree,
  line: number,
  character: number,
): string | null {
  // Get the deepest node at the position
  let node: Node | null = tree.rootNode.descendantForPosition({
    row: line,
    column: character,
  });
  // Walk up to find the identifier node at this position
  while (node) {
    if (node.type === "identifier" || node.type === "predef_identifier") {
      return node.text;
    }
    node = node.parent;
  }
  return null;
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
        return crossFileHover(crossFile, ctx, params.position);
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

      // Fallback: check if the identifier at cursor is a predef builtin or stdlib symbol.
      // This handles bare predef calls (e.g. write("hi")) where there is no local
      // declaration or access path to resolve.
      const identName = identifierAtPosition(
        hoverTree,
        params.position.line,
        params.position.character,
      );
      if (identName) {
        const line = params.position.line;
        const char = params.position.character;

        // Check predef builtins first
        const builtinSig = ctx.predefBuiltins[identName];
        if (builtinSig) {
          return formatHover({
            name: identName,
            signature: renderPredefSignature(identName, builtinSig),
            documentation: `Type signature (from Pike runtime):\n\`${builtinSig}\``,
            line,
            character: char,
            isAutodoc: true,
          });
        }

        // Check stdlib index
        const stdlibEntry = ctx.stdlibIndex[`predef.${identName}`];
        if (stdlibEntry) {
          return formatHover({
            name: identName,
            signature: stdlibEntry.signature,
            documentation: stdlibEntry.markdown,
            line,
            character: char,
            isAutodoc: true,
          });
        }
      }

      return null;
    }

    // For inherit/import declarations, resolve to the target file and show
    // its autodoc (the local declaration has no documentation of its own).
    if (decl.kind === "inherit" || decl.kind === "import") {
      const crossFile = await ctx.index.resolveCrossFileDefinition(
        params.textDocument.uri,
        params.position.line,
        params.position.character,
      );
      if (crossFile) {
        return crossFileHover(crossFile, ctx, params.position);
      }
    }

    return formatHover(declForHover(decl, params.textDocument.uri, ctx));
  });
}
