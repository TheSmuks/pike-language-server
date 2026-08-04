import { Node } from "web-tree-sitter";

/** Completion must not replace prose in comments or string literal contents. */
export function isNonCodePosition(node: Node): boolean {
  let current: Node | null = node;
  while (current) {
    if (current.type === "string_literal") return true;
    if (current.type === "line_comment") return true;
    if (current.type === "block_comment") return true;
    if (current.type === "autodoc_comment") return true;
    current = current.parent;
  }
  return false;
}
