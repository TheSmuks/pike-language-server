/**
 * Hover content: file-level autodoc collection.
 * Extracted from hoverContent.ts to keep file under 500 lines.
 */

import type { Node } from "web-tree-sitter";
import { parse } from "../parser";
import { renderAutodocLines } from "./autodocLineRenderer";
import type { HoverContentContext } from "./hoverContent";
import { formatHover, getSource } from "./hoverContent";

/** Collect consecutive autodoc_comment nodes from the top of a file. */
function collectFileAutodocFromChildren(children: Node[]): string[] {
  const fileLines: string[] = [];
  for (const child of children) {
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
}

/**
 * Build hover info for an implicit-class .pike file.
 * Reads the source, finds the first autodoc_comment, and renders it.
 */
export async function fileLevelHover(uri: string, name: string, ctx: HoverContentContext) {
  // Tier 1: check autodoc XML cache
  const cachedAutodoc = ctx.autodocCache.get(uri);
  if (cachedAutodoc?.xml) {
    const { renderAutodoc } = await import("./autodocRenderer");
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
  if (!tree) {
    return formatHover({ name, signature: `class ${name}`, documentation: "", line: 0, character: 0 });
  }

  const autodocLines = collectFileAutodocFromChildren(tree.rootNode.children);
  const nonEmpty = autodocLines.filter(l => l.length > 0);
  if (nonEmpty.length === 0) {
    return formatHover({ name, signature: `class ${name}`, documentation: "", line: 0, character: 0 });
  }

  const rendered = renderAutodocLines(autodocLines);
  return formatHover({
    name,
    signature: `class ${name}`,
    documentation: rendered || nonEmpty.join("\n\n"),
    line: 0,
    character: 0,
  });
}