// ---------------------------------------------------------------------------
// completion-chain.ts: Chained call type resolution for completion
// Extracted from completion.ts to reduce file size.
// ---------------------------------------------------------------------------
import { Node } from "web-tree-sitter";
import type { SymbolTable, Declaration } from "./symbolTable";
import { resolveMemberAccess } from "./typeResolver";
import type { CompletionContext } from "./completionTrigger";
import { findDeclarationForName } from "./completion-items";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single step in a postfix_expr chain.
 *
 * `baseName` is always set — it's the leftmost identifier.
 * `memberName` is set for arrow/dot access steps.
 */
interface ChainStep {
  baseName: string;
  memberName: string | null;
}

/**
 * Maximum depth for chained call type resolution.
 * Prevents runaway resolution on deeply nested or recursive chains.
 */
const MAX_CHAIN_DEPTH = 5;

// ---------------------------------------------------------------------------
// Main chain resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the type of an LHS expression for member access completion.
 *
 * Handles three patterns:
 * 1. Simple identifier: `d->` — look up `d`'s declaration, resolve its type.
 * 2. Single function call: `makeDog()->` — look up `makeDog`, resolve return type.
 * 3. Chained calls: `getContainer()->getItem()->` — walk the chain step by step,
 *    resolving each method's return type.
 *
 * Returns the Declaration whose type should be enumerated for completion items.
 * For chained calls, returns the declaration of the rightmost call's return type.
 * Returns null if the chain cannot be resolved.
 */
export async function resolveChainedType(
  lhsNode: Node,
  table: SymbolTable,
  line: number,
  character: number,
  ctx: CompletionContext,
): Promise<Declaration | null> {
  // Decompose the postfix_expr chain into steps.
  // Each step is either a base identifier or a ->memberName operation.
  const steps = decomposePostfixChain(lhsNode);
  if (steps.length === 0) {
    // Fallback: try simple name lookup on the raw node text.
    const name = lhsNode.text;
    return findDeclarationForName(table, name, line, character);
  }

  // Step 0: resolve the base identifier's declaration.
  const baseName = steps[0].baseName;
  let currentDecl = findDeclarationForName(table, baseName, line, character);
  if (!currentDecl) return null;

  // If there are no arrow steps, this is a simple case.
  // Return the base declaration so resolveTypeMembers can do its work.
  if (steps.length === 1 && !steps[0].memberName) {
    return currentDecl;
  }

  // Walk the chain: for each ->memberName step, resolve the member on
  // the current type, then set currentDecl to the member's declaration
  // (whose return type becomes the next step's type context).
  const typeCtx = {
    table,
    uri: ctx.uri,
    index: ctx.index,
    stdlibIndex: ctx.stdlibIndex,
    typeInferrer: ctx.typeInferrer,
  };

  for (let i = 0; i < steps.length && i < MAX_CHAIN_DEPTH; i++) {
    const step = steps[i];
    if (!step.memberName) continue;

    // Resolve the current type through the member access.
    // For each step, use that step's baseName (the identifier before the ->)
    // as the lookup name for the member access resolution.
    const member = await resolveMemberAccess(
      step.baseName,
      step.memberName,
      currentDecl,
      typeCtx,
    );
    if (!member) return null;

    // The member becomes the new "current declaration" for the next step.
    // If the member is a method/function, its declaredType is the return type.
    currentDecl = member;
  }

  return currentDecl;
}

// ---------------------------------------------------------------------------
// Chain decomposition
// ---------------------------------------------------------------------------

/**
 * Decompose a postfix_expr tree into a chain of steps.
 *
 * Given: `getContainer()->getItem()`
 * Tree: postfix_expr(postfix_expr(postfix_expr("getContainer") -> "getItem") (args))
 *
 * Returns:
 *   [{ baseName: "getContainer", memberName: null },
 *    { baseName: "getContainer", memberName: "getItem" }]
 *
 * Given: `d->bark()`
 * Tree: postfix_expr(postfix_expr("d") -> "bark") (args))
 *
 * Returns:
 *   [{ baseName: "d", memberName: null },
 *    { baseName: "d", memberName: "bark" }]
 *
 * Given: `makeDog()`
 * Tree: postfix_expr(postfix_expr("makeDog") (args))
 *
 * Returns:
 *   [{ baseName: "makeDog", memberName: null }]
 */
export function decomposePostfixChain(node: Node): ChainStep[] {
  const steps: ChainStep[] = [];

  // Walk the postfix_expr chain from outside in, collecting ->member steps.
  let current: Node | null = node;
  const arrowSteps: string[] = [];

  while (current && current.type === "postfix_expr") {
    const children = current.children;
    // Look for arrow/dot operator followed by an identifier.
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if ((child.type === "->" || child.type === "->?" || child.type === "?->")
          && i + 1 < children.length) {
        const memberIdent = children[i + 1];
        if (memberIdent && memberIdent.type === "identifier") {
          arrowSteps.push(memberIdent.text);
        }
      }
    }

    // Move to the first child (the nested postfix_expr or primary_expr).
    const inner = current.child(0);
    if (inner && inner.type === "postfix_expr") {
      current = inner;
    } else {
      // Reached the base: extract the identifier.
      const baseName = extractIdentifier(inner);
      if (baseName) {
        steps.push({ baseName, memberName: null });
      }
      break;
    }
  }

  // Arrow steps were collected outside-in, so reverse them to get
  // the correct left-to-right order.
  arrowSteps.reverse();
  if (steps.length > 0) {
    for (const member of arrowSteps) {
      steps.push({ baseName: steps[0].baseName, memberName: member });
    }
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the identifier name from a node.
 * Handles identifier, identifier_expr, and primary_expr wrapping.
 */
export function extractIdentifier(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "identifier_expr") {
    const nameNode = node.childForFieldName("name");
    return nameNode?.text ?? null;
  }
  if (node.type === "primary_expr") {
    return extractIdentifier(node.child(0));
  }
  return null;
}
