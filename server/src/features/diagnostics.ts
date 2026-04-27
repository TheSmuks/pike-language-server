import { Tree, Node, Point } from 'web-tree-sitter';

// Minimal LSP types — avoids pulling in vscode-languageserver-types just for diagnostics.

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export interface Diagnostic {
  range: Range;
  severity: DiagnosticSeverity;
  source: string;
  message: string;
}

function toPosition(point: Point): Position {
  return { line: point.row, character: point.column };
}

function toRange(node: Node): Range {
  return {
    start: toPosition(node.startPosition),
    end: toPosition(node.endPosition),
  };
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
    return {
      range: toRange(node),
      severity: DiagnosticSeverity.Error,
      source: 'pike-lsp',
      message,
    };
  });
}
