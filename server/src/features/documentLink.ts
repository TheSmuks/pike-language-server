/**
 * DocumentLink provider for Pike language server.
 *
 * Provides clickable links for import paths, inherit paths, and #include
 * directives, making it easy to navigate to module and include files.
 *
 * Decision 0027: Reuse ModuleResolver for path resolution.
 */
import {
  type Connection,
  type DocumentLink,
  type DocumentLinkParams,
  type CancellationToken,
} from "vscode-languageserver/node";
import type { TextDocuments } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { WorkspaceIndex } from "./workspaceIndex";
import type { ModuleResolver } from "./moduleResolver";
import { parse } from "../parser";
import type { Tree, Node } from "web-tree-sitter";

// ---------------------------------------------------------------------------
// DocumentLink handler
// ---------------------------------------------------------------------------

/**
 * Register the textDocument/documentLink handler.
 * Makes import paths, inherit paths, and #include directives clickable.
 */
export function registerDocumentLinkHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  index: WorkspaceIndex,
  resolver: ModuleResolver,
): void {
  connection.onDocumentLinks(async (params, token): Promise<DocumentLink[]> => {
    if (token.isCancellationRequested) return [];

    const uri = params.textDocument.uri;
    const doc = documents.get(uri);
    if (!doc) return [];

    return produceDocumentLinks(doc, uri, resolver);
  });
}

// ---------------------------------------------------------------------------
// DocumentLink production
// ---------------------------------------------------------------------------

/**
 * Produce DocumentLinks for a Pike document.
 * Walks the tree-sitter AST looking for import, inherit, and include nodes.
 */
async function produceDocumentLinks(
  doc: TextDocument,
  uri: string,
  resolver: ModuleResolver,
): Promise<DocumentLink[]> {
  const links: DocumentLink[] = [];

  const tree = parse(doc.getText(), uri);
  if (!tree?.rootNode) return [];

  walkForLinks(tree.rootNode, uri, links, resolver);

  return links;
}

/**
 * Walk the tree recursively, collecting import/inherit/include links.
 */
function walkForLinks(
  node: Node,
  currentUri: string,
  links: DocumentLink[],
  resolver: ModuleResolver,
): void {
  if (node.isError || node.isMissing) return;

  switch (node.type) {
    case "import_decl": {
      collectImportLink(node, currentUri, links, resolver);
      break;
    }
    case "inherit_decl": {
      collectInheritLink(node, currentUri, links, resolver);
      break;
    }
    case "preproc_include": {
      collectIncludeLink(node, currentUri, links);
      break;
    }
  }

  // Recurse into children.
  for (const child of node.children) {
    walkForLinks(child, currentUri, links, resolver);
  }
}

// ---------------------------------------------------------------------------
// Link collectors
// ---------------------------------------------------------------------------

/**
 * Collect DocumentLink for import statements: `import Stdio;`
 */
function collectImportLink(
  node: Node,
  currentUri: string,
  links: DocumentLink[],
  resolver: ModuleResolver,
): void {
  const pathNode = node.childForFieldName("path");
  if (!pathNode) return;

  const moduleName = pathNode.text;
  const range = toLinkRange(pathNode);

  const cached = resolver.getCachedModule(moduleName, currentUri);
  if (cached && cached.uri) {
    links.push({
      range,
      target: cached.uri,
    });
  }
}

/**
 * Collect DocumentLink for inherit statements:
 * - String literal: `inherit "path.pike"` or `inherit "../lib.pike"`
 * - Module name: `inherit Stdio` or `inherit Calendar.ISO`
 */
function collectInheritLink(
  node: Node,
  currentUri: string,
  links: DocumentLink[],
  resolver: ModuleResolver,
): void {
  const pathNode = node.childForFieldName("path");
  if (!pathNode) return;

  const pathText = pathNode.text;
  const range = toLinkRange(pathNode);

  const isStringLiteral = pathNode.type === "string";

  if (isStringLiteral) {
    const resolved = resolveRelativePath(pathText, currentUri);
    if (resolved) {
      links.push({ range, target: resolved });
    }
  } else {
    const cached = resolver.getCachedModule(pathText, currentUri);
    if (cached && cached.uri) {
      links.push({ range, target: cached.uri });
    }
  }
}

/**
 * Collect DocumentLink for #include directives:
 * `#include "path"` or `#include <path>`
 *
 * tree-sitter-pike provides a structured `preproc_include` node with a `path`
 * field containing either a `string_literal` or `system_lib_string` child.
 */
function collectIncludeLink(
  node: Node,
  currentUri: string,
  links: DocumentLink[],
): void {
  const pathNode = node.childForFieldName("path");
  if (!pathNode) return;

  // Only resolve "..." includes (string_literal). Angle-bracket <...>
  // includes (system_lib_string) resolve against Pike's include path
  // which we don't have access to.
  if (pathNode.type === "system_lib_string") return;

  // Strip surrounding quotes from the string literal.
  const pathText = pathNode.text.replace(/^["]+|["]+$/g, "");
  if (pathText.length === 0) return;

  const range = toLinkRange(pathNode);
  const resolved = resolveRelativePath(pathText, currentUri);
  if (resolved) {
    links.push({ range, target: resolved });
  }
}

// ---------------------------------------------------------------------------
// Path resolution helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Pike relative path to a file:// URI.
 * Handles paths like "foo/bar.pike", "../lib.pike", "./helper.pike".
 */
function resolveRelativePath(
  pathText: string,
  currentUri: string,
): string | null {
  const cleanPath = pathText.replace(/^["]+|["]+$/g, "");
  if (cleanPath.length === 0) return null;

  // Compute absolute path relative to current file's directory.
  // currentUri is like "file:///path/to/file.pike"
  const currentPath = decodeURIComponent(currentUri.replace("file://", ""));
  const currentDir = currentPath.substring(0, currentPath.lastIndexOf("/"));

  let targetPath: string;
  if (cleanPath.startsWith("../")) {
    let upCount = 0;
    let remaining = cleanPath;
    while (remaining.startsWith("../")) {
      upCount++;
      remaining = remaining.substring(3);
    }
    const parts = currentDir.split("/");
    if (upCount >= parts.length) return null;
    targetPath = parts.slice(0, -upCount).join("/") + "/" + remaining;
  } else if (cleanPath.startsWith("./")) {
    targetPath = currentDir + "/" + cleanPath.substring(2);
  } else {
    targetPath = currentDir + "/" + cleanPath;
  }

  return "file://" + encodeURI(targetPath);
}

// ---------------------------------------------------------------------------
// Range helpers
// ---------------------------------------------------------------------------

interface LspRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/**
 * Convert tree-sitter positions to LSP range for DocumentLink.
 */
function toLinkRange(node: Node): LspRange {
  return {
    start: {
      line: node.startPosition.row,
      character: node.startPosition.column,
    },
    end: {
      line: node.endPosition.row,
      character: node.endPosition.column,
    },
  };
}
