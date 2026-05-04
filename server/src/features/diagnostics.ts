/**
 * Parse diagnostics — converts tree-sitter ERROR nodes to LSP Diagnostics.
 *
 * Uses canonical LSP types from vscode-languageserver (decision 0018).
 */

import {
  Diagnostic,
  DiagnosticSeverity,
  Range,
  Position,
} from 'vscode-languageserver/node';
import { Tree, Node, Point } from 'web-tree-sitter';

export { Diagnostic, DiagnosticSeverity, Range, Position };

function toPosition(point: Point): Position {
  return Position.create(point.row, point.column);
}

function toRange(node: Node): Range {
  return Range.create(toPosition(node.startPosition), toPosition(node.endPosition));
}

function findErrorNodes(node: Node): Node[] {
  const errors: Node[] = [];
  if (node.type === 'ERROR' || node.isError) {
    errors.push(node);
    // Don't recurse into ERROR nodes — the children are recovery artifacts.
    return errors;
  }
  for (const child of node.children) {
    errors.push(...findErrorNodes(child));
  }
  return errors;
}

/**
 * Narrow the range to the specific problematic token.
 *
 * Tree-sitter ERROR nodes span the entire recovery region, which can
 * cover multiple lines if the parser resynchronizes. This function
 * narrows the range to the first "meaningful" token within the ERROR node.
 *
 * - Single child: use the child's range (the unexpected token).
 * - Multiple children: use the first child that isn't whitespace/newline.
 */
function narrowErrorRange(node: Node): Range {
  const childCount = node.childCount;

  // Single child: use just that child's range.
  if (childCount === 1) {
    const child = node.child(0)!;
    return Range.create(toPosition(child.startPosition), toPosition(child.endPosition));
  }

  // Multiple children: find the first non-padding token.
  for (let i = 0; i < childCount; i++) {
    const child = node.child(i)!;
    const type = child.type;
    // Skip whitespace-only and padding nodes.
    if (type === 'ERROR') continue; // Don't nest.
    if (type === 'missing') continue;
    if (child.text.trim().length > 0) {
      return Range.create(toPosition(child.startPosition), toPosition(child.endPosition));
    }
  }

  // Fallback: look at the first token that has content.
  for (let i = 0; i < childCount; i++) {
    const child = node.child(i)!;
    if (child.type !== 'ERROR' && child.type !== 'missing') {
      return Range.create(toPosition(child.startPosition), toPosition(child.endPosition));
    }
  }

  // Absolute fallback: just the first byte of the ERROR node.
  return Range.create(
    toPosition(node.startPosition),
    Position.create(node.startPosition.row, node.startPosition.column + 1),
  );
}

/**
 * Generate a descriptive error message based on the ERROR node's context.
 *
 * Examines the ERROR node's children and parent to infer what went wrong.
 * Falls back to a generic message for unrecognized patterns.
 */
function describeError(node: Node, unexpected: string): string {
  const parent = node.parent;

  // Check for common patterns based on parent context.
  if (parent) {
    const parentType = parent.type;

    // Class/body context: missing opening brace.
    if (parentType === 'class_declaration' || parentType === 'class_body') {
      // Look for class name before the error.
      const classKeyword = parent.childForFieldName('class');
      if (classKeyword && classKeyword.endPosition.row === node.startPosition.row) {
        return `Expected '{' after class declaration`;
      }
    }

    // Block context: missing closing brace.
    if (parentType === 'block') {
      // Error at the end of a block usually means missing '}'.
      return `Expected '}' to close block`;
    }

    // Function body: missing opening brace.
    if (parentType === 'function_definition' || parentType === 'function_declaration') {
      const nameNode = parent.childForFieldName('name');
      if (nameNode && nameNode.endPosition.row === node.startPosition.row) {
        return `Expected '{' after function declaration`;
      }
    }
  }

  // Specific token-based messages.
  switch (unexpected) {
    case ')':
      // Check if we had a matching '(' in the error node.
      const hasOpenParen = node.children.some((c) => c.type === '(' || c.type === 'expression_list');
      if (!hasOpenParen) {
        return `Unexpected ')', no matching open parenthesis`;
      }
      return `Parse error: unexpected ')'`;

    case '}':
      return `Parse error: unexpected '}'`;

    case ';':
      // Semicolon in unexpected position - check context.
      if (node.childCount > 0 && node.children[0].type === ';') {
        return `Unexpected ';', expected expression or declaration`;
      }
      return `Parse error: unexpected ';'`;

    case '(':
      return `Unexpected '(', expected expression`;

    case ']':
      return `Unexpected ']', expected expression`;

    default:
      return `Parse error: unexpected '${unexpected}'`;
  }
}

export function getParseDiagnostics(tree: Tree): Diagnostic[] {
  const errorNodes = findErrorNodes(tree.rootNode);
  return errorNodes.map((node, index) => {
    const child = node.lastChild;
    const unexpected = child?.type;
    let message: string;
    if (unexpected) {
      message = describeError(node, unexpected);
    } else {
      // Check if we're at EOF.
      const next = node.nextSibling;
      if (!next && node.endPosition.row === tree.rootNode.endPosition.row) {
        message = 'Unexpected end of file';
      } else {
        message = 'Parse error: unexpected token';
      }
    }
    return Diagnostic.create(
      narrowErrorRange(node),
      message,
      DiagnosticSeverity.Error,
      `P1${String(index).padStart(3, '0')}`, // Parse error code
      'pike-lsp',
    );
  });
}