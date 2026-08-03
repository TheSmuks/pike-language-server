/**
 * Choosing the trigger for the caret's position.
 *
 * Split out of completion.ts to keep both files under the 500-line limit.
 */

import type { Node, Tree } from "web-tree-sitter";
import { type TriggerContext, detectTriggerContext } from "./completionTrigger";

/** A trigger that names a receiver or scope, rather than "anything in scope". */
function isQualifiedTrigger(context: TriggerContext): boolean {
  return context.type === "dot" || context.type === "arrow" || context.type === "scope";
}


/**
 * The trigger for this caret, and the node it was decided from.
 *
 * The caret sits just PAST the last character typed, which is a token
 * boundary. While a statement is unfinished, `s->na|` makes tree-sitter answer
 * the ERROR node spanning the incomplete statement rather than `na` — so the
 * member trigger was lost the moment a prefix was typed, the whole global scope
 * was offered instead (without the member being typed), and every item
 * inherited that node's multi-line span as its edit range. Re-ask one column
 * back, where the token being typed is, and prefer a qualified answer.
 */
export function resolveTriggerAtCaret(
  root: Node,
  node: Node,
  line: number,
  character: number,
  tree: Tree,
  lineText: string,
): { node: Node; context: TriggerContext } {
  const context = detectTriggerContext(node, line, character, tree, lineText);
  if (isQualifiedTrigger(context) || character === 0) return { node, context };

  const prevNode = root.descendantForPosition({ row: line, column: character - 1 });
  if (!prevNode) return { node, context };

  const prevContext = detectTriggerContext(prevNode, line, character - 1, tree, lineText);
  return isQualifiedTrigger(prevContext)
    ? { node: prevNode, context: prevContext }
    : { node, context };
}
