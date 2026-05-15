/**
 * #include resolution helpers for navigation (CTRL+CLICK on #include).
 *
 * Extracted from navigationHandler.ts to keep file sizes under 500 lines.
 */

import type { Location as LspLocation } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Node as TsNode } from "web-tree-sitter";
import { parse } from "../parser";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { uriToPath } from "../util/uri";
import { pathToFileURL } from "node:url";

/**
 * If the cursor is on a `preproc_include` node, resolve the target file
 * and return an LSP Location for navigation (CTRL+CLICK on #include).
 *
 * tree-sitter-pike provides a structured `preproc_include` node with a
 * `path` field containing either `string_literal` or `system_lib_string`.
 *
 * For `"..."` includes: resolve relative to current file directory.
 * For `<...>` includes: search Pike's include paths (from `pike --show-paths`).
 */
export function resolveIncludeTarget(
  doc: TextDocument,
  uri: string,
  line: number,
  character: number,
  includePaths: string[],
  workspaceRoot: string,
): LspLocation | null {
  const tree = parse(doc.getText(), uri);
  if (!tree?.rootNode) return null;

  const node = findNodeAtPosition(tree.rootNode, line, character);
  if (!node) return null;

  // findNodeAtPosition returns the deepest node. We want preproc_include
  // OR a direct child of preproc_include (e.g. system_lib_string when
  // clicking inside <stdio.h>). Walk up to find the include directive.
  let includeNode: TsNode | null = node;
  if (node.type !== "preproc_include") {
    includeNode = node.parent;
    while (includeNode && includeNode.type !== "preproc_include") {
      includeNode = includeNode.parent;
    }
  }
  if (!includeNode || includeNode.type !== "preproc_include") return null;

  const pathNode = includeNode.childForFieldName("path");
  if (!pathNode) return null;

  if (pathNode.type === "system_lib_string") {
    // Angle-bracket include: strip < and > from the text, then search
    // Pike's include directories.
    const pathText = pathNode.text.replace(/^<|>$/g, "");
    if (pathText.length === 0) return null;
    return resolveIncludeInSearchPaths(pathText, includePaths);
  }

  // String literal include: resolve relative to current file directory.
  const pathText = pathNode.text.replace(/^[\"]+|[\"]+$/g, "");
  if (pathText.length === 0) return null;

  const currentPath = uriToPath(uri);
  const currentDir = currentPath.substring(0, currentPath.lastIndexOf("/"));
  const targetPath = resolveRelativeIncludePath(pathText, currentDir, workspaceRoot);
  if (!targetPath) return null;

  return {
    uri: pathToFileURL(targetPath).href,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
  };
}

/**
 * Search include directories for a system header file.
 * Returns an LSP Location if the file exists, null otherwise.
 */
function resolveIncludeInSearchPaths(
  pathText: string,
  includePaths: string[],
): LspLocation | null {
  for (const dir of includePaths) {
    const candidate = join(dir, pathText);
    if (existsSync(candidate)) {
      return {
        uri: pathToFileURL(candidate).href,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      };
    }
  }
  return null;
}

/**
 * Walk the tree to find the deepest node at a given position.
 */
function findNodeAtPosition(
  node: TsNode,
  line: number,
  character: number,
): TsNode | null {
  if (
    line < node.startPosition.row ||
    line > node.endPosition.row
  ) return null;
  if (
    line === node.startPosition.row && character < node.startPosition.column
  ) return null;
  if (
    line === node.endPosition.row && character > node.endPosition.column
  ) return null;

  for (const child of node.children) {
    const found = findNodeAtPosition(child, line, character);
    if (found) return found;
  }

  return node;
}

/**
 * Resolve a relative include path against a base directory.
 * Handles `../`, `./`, and bare filenames.
 */
function resolveRelativeIncludePath(
  rawPath: string,
  baseDir: string,
  workspaceRoot: string,
): string | null {
  const cleanPath = rawPath.replace(/^[\"]+|[\"]+$/g, "");
  if (cleanPath.length === 0) return null;

  let targetPath: string;
  if (cleanPath.startsWith("../")) {
    let upCount = 0;
    let remaining = cleanPath;
    while (remaining.startsWith("../")) {
      upCount++;
      remaining = remaining.substring(3);
    }
    const parts = baseDir.split("/");
    if (upCount >= parts.length) return null;
    targetPath = parts.slice(0, -upCount).join("/") + "/" + remaining;
  } else if (cleanPath.startsWith("./")) {
    targetPath = baseDir + "/" + cleanPath.substring(2);
  } else {
    targetPath = baseDir + "/" + cleanPath;
  }

  // Security: reject paths that escaped the workspace.
  const normalized = resolve(targetPath);
  if (!normalized.startsWith(workspaceRoot)) return null;

  return normalized;
}
