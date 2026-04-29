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

export function getParseDiagnostics(tree: Tree): Diagnostic[] {
  const errorNodes = findErrorNodes(tree.rootNode);
  return errorNodes.map((node) => {
    const unexpected = node.lastChild?.type;
    const message = unexpected
      ? `Parse error: unexpected ${unexpected}`
      : 'Parse error';
    return Diagnostic.create(
      toRange(node),
      message,
      DiagnosticSeverity.Error,
      undefined,
      'pike-lsp',
    );
  });
}
