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

  // Parse the document to get the tree
  const tree = parse(doc.getText(), uri);
  if (!tree?.rootNode) return [];

  // Walk the tree looking for relevant nodes
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

  // Recurse into children
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
  // import_decl has a 'path' field with the module name
  const pathNode = node.childForFieldName("path");
  if (!pathNode) return;

  const moduleName = pathNode.text;
  const range = toLinkRange(pathNode);

  // Try cached resolution first (sync)
  const cached = resolver.getCachedModule(moduleName, currentUri);
  if (cached && cached.uri) {
    links.push({
      range,
      target: cached.uri,
    });
    return;
  }

  // For unresolved modules, the link has no target — editor may show as unresolved
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
  // inherit_decl has a 'path' field with the path/module name
  const pathNode = node.childForFieldName("path");
  if (!pathNode) return;

  const pathText = pathNode.text;
  const range = toLinkRange(pathNode);

  // Check if path is a string literal (direct file path) or identifier (module)
  const isStringLiteral = pathNode.type === "string";

  if (isStringLiteral) {
    // Direct file path like "foo/bar.pike" or "../lib.pike"
    const resolved = resolveRelativePath(pathText, currentUri);
    if (resolved) {
      links.push({
        range,
        target: resolved,
      });
    }
  } else {
    // Module name like Stdio or Calendar.ISO
    const cached = resolver.getCachedModule(pathText, currentUri);
    if (cached && cached.uri) {
      links.push({
        range,
        target: cached.uri,
      });
    }
  }
}

/**
 * Collect DocumentLink for preprocessor include directives:
 * `#include "path"` or `#include <path>`
 */
function collectIncludeLink(
  node: Node,
  currentUri: string,
  links: DocumentLink[],
): void {
  // preproc_include children include the #include keyword and the path
  // Find string or preproc_string child
  const pathNode = node.children.find(
    (c) => c.type === "string" || c.type === "preproc_string",
  );
  if (!pathNode) return;

  // Strip quotes/brackets from path
  const pathText = pathNode.text.replace(/^["<>]+|["<>]+$/g, "");
  const range = toLinkRange(pathNode);

  // Resolve relative to current file directory
  const resolved = resolveRelativePath(pathText, currentUri);
  if (resolved) {
    links.push({
      range,
      target: resolved,
    });
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
  // Strip quotes from string literal
  const cleanPath = pathText.replace(/^["]+|["]+$/g, "");

  // Compute absolute path relative to current file's directory
  // currentUri is like "file:///path/to/file.pike"
  const currentPath = decodeURIComponent(currentUri.replace("file://", ""));
  const currentDir = currentPath.substring(0, currentPath.lastIndexOf("/"));

  // Simple relative path resolution
  let targetPath: string;
  if (cleanPath.startsWith("../")) {
    // Go up directories
    let upCount = 0;
    let remaining = cleanPath;
    while (remaining.startsWith("../")) {
      upCount++;
      remaining = remaining.substring(3);
    }
    const parts = currentDir.split("/");
    targetPath = parts.slice(0, -upCount).join("/") + "/" + remaining;
  } else if (cleanPath.startsWith("./")) {
    // Same directory
    targetPath = currentDir + "/" + cleanPath.substring(2);
  } else {
    // Same directory (no prefix)
    targetPath = currentDir + "/" + cleanPath;
  }

  // Convert to file:// URI
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
 * DocumentLink uses LSP Range format.
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