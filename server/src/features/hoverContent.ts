/**
 * Hover content formatting — declaration-to-hover-info conversion.
 *
 * Extracted from hoverHandler.ts to keep it under 500 lines.
 * Re-exported by hoverHandler.ts so existing imports continue to work.
 */

import { MarkupKind } from "vscode-languageserver/node";
import type { MarkupContent, Hover } from "vscode-languageserver/node";
import type { TextDocuments } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { parse } from "../parser";
import type { Node } from "web-tree-sitter";
import type { Declaration } from "./symbolTable";
import { renderAutodoc } from "./autodocRenderer";
import type { LRUCache } from "../util/lruCache";
import { stripScopeWrapper } from "../util/stripScope";
import { readFileSync } from "node:fs";
import { uriToPath } from "../util/uri";
import { renderAutodocLines } from "./autodocLineRenderer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HoverInfo {
  name: string;
  signature: string;
  documentation: string;
  line: number;
  character: number;
  /** If true, documentation is already full markdown (from autodoc). */
  isAutodoc?: boolean;
}

export interface HoverContentContext {
  documents: TextDocuments<TextDocument>;
  autodocCache: LRUCache<{ xml: string; hash: string; timestamp: number }>;
  stdlibIndex: Record<string, { signature: string; markdown: string }>;
  predefBuiltins: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render a predef builtin type signature into a human-readable display form.
 */
export function renderPredefSignature(name: string, rawSig: string): string {
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
export function formatHover(info: HoverInfo | null): Hover | null {
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

export function getSource(uri: string, documents: TextDocuments<TextDocument>): string | null {
  const doc = documents.get(uri);
  if (doc) return doc.getText();
  // Cross-file: document not open in editor. Read from disk.
  if (uri.startsWith("file://")) {
    try {
      return readFileSync(uriToPath(uri), "utf8");
    } catch {
      // Disk/permission errors — fall through to return null.
      return null;
    }
  }
  return null;
}

/**
 * Build hover info for a declaration from any source.
 * Implements the three-tier hover resolution:
 *   Tier 1: Workspace AutoDoc — XML from PikeExtractor (cached)
 *   Tier 2: Stdlib — pre-computed index (hash lookup)
 *   Tier 3: Tree-sitter — bare declared type
 */
export function declForHover(
  decl: {
    name: string;
    kind: string;
    nameRange: { start: { line: number; character: number } };
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
  },
  uri: string,
  ctx: HoverContentContext,
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
 * Build hover info for an implicit-class .pike file.
 * Reads the source, finds the first autodoc_comment, and renders it.
 */
export function fileLevelHover(uri: string, name: string, ctx: HoverContentContext): Hover | null {
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
      const fileLines: string[] = [];
      for (const child of root.children) {
        if (child.type === "autodoc_comment") {
          // Strip //! prefix, keep empty lines as paragraph separators
          const text = child.text.replace(/^\/\/!\s?/, "");
          fileLines.push(text);
        } else if (child.type === "comment") {
          // Skip regular comments but keep going
          continue;
        } else {
          // Stop at first non-comment, non-whitespace node
          break;
        }
      }
      return fileLines;
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
