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
} from "vscode-languageserver/node";
import type { TextDocuments } from "vscode-languageserver/node";
import type { TextDocument } from "vscode-languageserver-textdocument";
import type { ModuleResolver } from "./moduleResolver";
import { parse } from "../parser";
import type { Node } from "web-tree-sitter";
import { uriToPath } from "../util/uri";

// ---------------------------------------------------------------------------
// DocumentLink handler
// ---------------------------------------------------------------------------

/**
 * Register the textDocument/documentLink handler.
 * Makes import paths, inherit paths, and #include directives clickable.
 *
 * `getResolver` is a thunk, not a plain value: this registration runs at
 * server construction, before the LSP `initialize` handshake replaces the
 * placeholder WorkspaceIndex (workspaceRoot `/tmp/unused`, no detected Pike
 * paths) with the real one built from `pike --show-paths`. Capturing
 * `ctx.index.resolver` by value here would freeze on that placeholder's
 * resolver forever — every `#include <...>` and workspace-relative link
 * would silently fail to resolve for the life of the connection. Calling
 * the thunk inside the request handler reads the current resolver instead,
 * mirroring the `get index()` getter pattern already used in server.ts for
 * the same reason.
 */
export function registerDocumentLinkHandler(
  connection: Connection,
  documents: TextDocuments<TextDocument>,
  getResolver: () => ModuleResolver,
): void {
  connection.onDocumentLinks(async (params, token): Promise<DocumentLink[]> => {
    if (token.isCancellationRequested) return [];

    const uri = params.textDocument.uri;
    const doc = documents.get(uri);
    if (!doc) return [];

    return produceDocumentLinks(doc, uri, getResolver());
  });
}

// ---------------------------------------------------------------------------
// DocumentLink production
// ---------------------------------------------------------------------------

/**
 * Produce DocumentLinks for a Pike document.
 * Walks the tree-sitter AST looking for import, inherit, and include nodes.
 *
 * Path resolution is delegated to ModuleResolver so links match how the symbol
 * table itself resolves targets — including `#include`/inherit strings that
 * point outside the workspace (e.g. `#include "../defs.h"`).
 */
async function produceDocumentLinks(
  doc: TextDocument,
  uri: string,
  resolver: ModuleResolver,
): Promise<DocumentLink[]> {
  const source = doc.getText();
  const tree = parse(source, uri);
  if (!tree?.rootNode) return [];

  const fromPath = uriToPath(uri);
  const links: DocumentLink[] = [];
  const pending: Promise<void>[] = [];

  collectLinks(tree.rootNode, fromPath, links, pending, resolver);
  await Promise.all(pending);

  return links;
}

/**
 * Walk the tree recursively, collecting import/inherit/include links.
 * Module/import targets resolve synchronously from the warm resolver cache;
 * inherit-string and #include targets resolve asynchronously (pushed onto
 * `pending`) so out-of-workspace relative paths hit the filesystem via the
 * resolver's relaxed boundary.
 */
function collectLinks(
  node: Node,
  fromPath: string,
  links: DocumentLink[],
  pending: Promise<void>[],
  resolver: ModuleResolver,
): void {
  if (node.isError || node.isMissing) return;

  switch (node.type) {
    case "import_decl": {
      collectModuleLink(node, fromPath, links, resolver);
      break;
    }
    case "inherit_decl": {
      collectInheritLink(node, fromPath, links, pending, resolver);
      break;
    }
    case "preproc_include": {
      collectIncludeLink(node, fromPath, links, pending, resolver);
      break;
    }
  }

  for (const child of node.children) {
    collectLinks(child, fromPath, links, pending, resolver);
  }
}

// ---------------------------------------------------------------------------
// Link collectors
// ---------------------------------------------------------------------------

/** DocumentLink for a module reference: `import Stdio;` (sync cache lookup). */
function collectModuleLink(
  node: Node,
  fromPath: string,
  links: DocumentLink[],
  resolver: ModuleResolver,
): void {
  const pathNode = node.childForFieldName("path");
  if (!pathNode) return;

  const cached = resolver.getCachedModule(pathNode.text, fromPath);
  if (cached?.uri) {
    links.push({ range: toLinkRange(pathNode), target: cached.uri });
  }
}

/**
 * DocumentLink for inherit statements:
 * - String literal: `inherit "path.pike"` / `inherit "../lib.pike"` (async).
 * - Module name: `inherit Stdio` / `inherit Calendar.ISO` (sync cache).
 */
function collectInheritLink(
  node: Node,
  fromPath: string,
  links: DocumentLink[],
  pending: Promise<void>[],
  resolver: ModuleResolver,
): void {
  const pathNode = node.childForFieldName("path");
  if (!pathNode) return;

  const range = toLinkRange(pathNode);

  if (pathNode.type === "string") {
    pending.push(
      resolver.resolveInherit(pathNode.text, true, fromPath).then((res) => {
        if (res?.uri) links.push({ range, target: res.uri });
      }),
    );
    return;
  }

  const cached = resolver.getCachedModule(pathNode.text, fromPath);
  if (cached?.uri) {
    links.push({ range, target: cached.uri });
  }
}

/**
 * DocumentLink for #include directives: `#include "path"` / `#include <path>`.
 * Resolution (including out-of-workspace relative paths and the -I search for
 * `<...>`) is delegated to ModuleResolver.resolveInclude.
 */
function collectIncludeLink(
  node: Node,
  fromPath: string,
  links: DocumentLink[],
  pending: Promise<void>[],
  resolver: ModuleResolver,
): void {
  const pathNode = node.childForFieldName("path");
  if (!pathNode) return;

  const isSystem = pathNode.type === "system_lib_string";
  const range = toLinkRange(pathNode);
  pending.push(
    resolver.resolveInclude(pathNode.text, isSystem, fromPath).then((res) => {
      if (res?.uri) links.push({ range, target: res.uri });
    }),
  );
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
    start: { line: node.startPosition.row, character: node.startPosition.column },
    end: { line: node.endPosition.row, character: node.endPosition.column },
  };
}
