/**
 * #include resolution helpers for navigation (CTRL+CLICK on #include).
 *
 * Extracted from navigationHandler.ts to keep file sizes under 500 lines.
 */

import type { Location as LspLocation } from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import type { Node as TsNode } from "web-tree-sitter";
import { parse } from "../parser";

/** Resolves an include path to a target file URI (via ModuleResolver). */
export type IncludeResolver = (pathText: string, isSystem: boolean) => Promise<string | null>;

/**
 * If the cursor is on a `preproc_include` node, resolve the target file and
 * return an LSP Location for navigation (CTRL+CLICK on #include).
 *
 * Resolution is delegated to ModuleResolver (via `resolveInclude`) so it matches
 * how the symbol table resolves includes — `"..."` relative to the current file
 * (including `../` outside the workspace) and `<...>` against Pike's -I paths.
 */
export async function resolveIncludeTarget(
  doc: TextDocument,
  uri: string,
  line: number,
  character: number,
  resolveInclude: IncludeResolver,
): Promise<LspLocation | null> {
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
  if (!pathNode || pathNode.text.length === 0) return null;

  const isSystem = pathNode.type === "system_lib_string";
  const targetUri = await resolveInclude(pathNode.text, isSystem);
  if (!targetUri) return null;

  return {
    uri: targetUri,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
  };
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
