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
import { utf8ToUtf16 } from '../util/positionConverter';

export { Diagnostic, DiagnosticSeverity, Range, Position };

function toPosition(point: Point, lines: string[]): Position {
  return Position.create(point.row, utf8ToUtf16(lines[point.row] ?? '', point.column));
}

function toRange(node: Node, lines: string[]): Range {
  return Range.create(toPosition(node.startPosition, lines), toPosition(node.endPosition, lines));
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
function narrowErrorRange(node: Node, lines: string[]): Range {
  const childCount = node.childCount;

  // Single child: use just that child's range.
  if (childCount === 1) {
    const child = node.child(0);
    if (!child) return Range.create(toPosition(node.startPosition, lines), toPosition(node.endPosition, lines));
    return Range.create(toPosition(child.startPosition, lines), toPosition(child.endPosition, lines));
  }

  // Multiple children: find the first non-padding token.
  for (let i = 0; i < childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const type = child.type;
    // Skip whitespace-only and padding nodes.
    if (type === 'ERROR') continue; // Don't nest.
    if (type === 'missing') continue;
    if (child.text.trim().length > 0) {
      return Range.create(toPosition(child.startPosition, lines), toPosition(child.endPosition, lines));
    }
  }

  // Fallback: look at the first token that has content.
  for (let i = 0; i < childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    if (child.type !== 'ERROR' && child.type !== 'missing') {
      return Range.create(toPosition(child.startPosition, lines), toPosition(child.endPosition, lines));
    }
  }

  // Absolute fallback: just the first byte of the ERROR node.
  return Range.create(
    toPosition(node.startPosition, lines),
    Position.create(node.startPosition.row, utf8ToUtf16(lines[node.startPosition.row] ?? '', node.startPosition.column) + 1),
  );
}

/**
 * Check parent context for common structural errors (missing braces).
 */
function describeErrorFromContext(node: Node): string | undefined {
  const parent = node.parent;
  if (!parent) return;

  const parentType = parent.type;
  if (parentType === 'class_declaration' || parentType === 'class_body') {
    const classKeyword = parent.childForFieldName('class');
    if (classKeyword && classKeyword.endPosition.row === node.startPosition.row) {
      return `Expected '{' after class declaration`;
    }
  }
  if (parentType === 'block') {
    return `Expected '}' to close block`;
  }
  if (parentType === 'function_definition' || parentType === 'function_declaration') {
    const nameNode = parent.childForFieldName('name');
    if (nameNode && nameNode.endPosition.row === node.startPosition.row) {
      return `Expected '{' after function declaration`;
    }
  }
}

/**
 * Generate a descriptive error message based on the ERROR node's context.
 *
 * Examines the ERROR node's children and parent to infer what went wrong.
 * Falls back to a generic message for unrecognized patterns.
 */
function describeError(node: Node, unexpected: string): string {
  const ctxMsg = describeErrorFromContext(node);
  if (ctxMsg) return ctxMsg;

  // Specific token-based messages.
  switch (unexpected) {
    case ')':
      const hasOpenParen = node.children.some((c) => c.type === '(' || c.type === 'expression_list');
      return hasOpenParen ? `Parse error: unexpected ')'` : `Unexpected ')', no matching open parenthesis`;
    case '}': return `Parse error: unexpected '}'`;
    case ';':
      return node.childCount > 0 && node.children[0].type === ';'
        ? `Unexpected ';', expected expression or declaration`
        : `Parse error: unexpected ';'`;
    case '(': return `Unexpected '(', expected expression`;
    case ']': return `Unexpected ']', expected expression`;
    default:  return `Parse error: unexpected '${unexpected}'`;
  }
}

export function getParseDiagnostics(tree: Tree, lines: string[]): Diagnostic[] {
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
      narrowErrorRange(node, lines),
      message,
      DiagnosticSeverity.Error,
      `P1${String(index).padStart(3, '0')}`, // Parse error code
      'pike-lsp',
    );
  });
}