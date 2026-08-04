import type { Tree } from "web-tree-sitter";
import type { CallHierarchyItem } from "vscode-languageserver/node";
import type { Declaration, SymbolTable } from "./symbolTable";
import { getDefinitionAt } from "./symbolTable";
import { isWrittenInFile } from "./query";
import type { WorkspaceIndex } from "./workspaceIndex";
import { resolveAccessDeclaration, type ResolutionContext } from "./accessResolver";

export interface ResolvedCallee {
  readonly item: CallHierarchyItem;
  readonly decl: Declaration;
  readonly uri: string;
}

export async function resolveCallee(
  name: string, table: SymbolTable, uri: string, fromLine: number, fromCol: number,
  workspaceIndex: WorkspaceIndex, tree?: Tree, resolution?: ResolutionContext,
): Promise<ResolvedCallee | null> {
  const typed = await resolveTypedCallee(table, uri, fromLine, fromCol, tree, resolution);
  if (typed) return typed;
  const crossFile = await resolveCrossFileCallee(uri, fromLine, fromCol, workspaceIndex);
  if (crossFile) return crossFile;
  const resolved = getDefinitionAt(table, fromLine, fromCol);
  if (isCallable(resolved)) return resolvedCallee(resolved, resolved.sourceUri ?? uri);
  const local = findLocalCallee(name, table, uri);
  if (local) return local;
  return findWorkspaceCallee(name, workspaceIndex);
}

async function resolveTypedCallee(table: SymbolTable, uri: string, line: number, column: number, tree?: Tree, resolution?: ResolutionContext): Promise<ResolvedCallee | null> {
  if (!tree || !resolution) return null;
  const access = await resolveAccessDeclaration(resolution, table, uri, line, column, tree);
  if (!access || !isCallable(access.decl)) return null;
  return resolvedCallee(access.decl, access.decl.sourceUri ?? access.uri);
}

async function resolveCrossFileCallee(uri: string, line: number, column: number, index: WorkspaceIndex): Promise<ResolvedCallee | null> {
  if (typeof index.resolveCrossFileDefinition !== "function") return null;
  const crossFile = await index.resolveCrossFileDefinition(uri, line, column);
  if (!crossFile || !isCallable(crossFile.decl)) return null;
  return resolvedCallee(crossFile.decl, crossFile.decl.sourceUri ?? crossFile.uri);
}

function findLocalCallee(name: string, table: SymbolTable, uri: string): ResolvedCallee | null {
  for (const decl of table.declarations) {
    if (!isWrittenInFile(table, decl)) continue;
    if (decl.name === name && isCallable(decl)) return resolvedCallee(decl, uri);
  }
  return null;
}

function findWorkspaceCallee(name: string, index: WorkspaceIndex): ResolvedCallee | null {
  for (const entry of index.getAllEntries()) {
    if (!entry.symbolTable) continue;
    for (const decl of entry.symbolTable.declarations) {
      if (decl.name === name && isCallable(decl)) return resolvedCallee(decl, decl.sourceUri ?? entry.uri);
    }
  }
  return null;
}

function isCallable(decl: Declaration | null): decl is Declaration {
  return decl?.kind === "function" || decl?.kind === "method";
}

function resolvedCallee(decl: Declaration, uri: string): ResolvedCallee {
  return { item: declToCallHierarchyItem(decl, uri), decl, uri };
}

export function declToCallHierarchyItem(decl: Declaration, uri: string): CallHierarchyItem {
  return {
    name: decl.name, kind: decl.kind === "method" ? 6 : 12, uri,
    range: { start: decl.range.start, end: decl.range.end },
    selectionRange: { start: decl.nameRange.start, end: decl.nameRange.end },
  };
}
