/**
 * Declaration harvesting for the Roxen index generator.
 *
 * Roxen's AutoDoc covers only what carries a `//!` comment, and most of what
 * Roxen code actually touches carries none: `RoxenModule`'s prototype in
 * prototypes.pike is a wall of bare declarations, and the globals roxenloader
 * injects are ordinary functions that happen to be handed to `add_constant`.
 * Harvesting those needs a parser rather than the AutoDoc extractor, so this
 * module reads them with the same tree-sitter grammar the server ships.
 *
 * Everything here is derived from the source: no member list, no global list,
 * and not even the exclusion set — prototypes.pike names its own exclusions in
 * `constant ignore_identifiers`, and that is what is read.
 */
import type { Node } from "web-tree-sitter";
import { parse } from "../server/src/parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeclInfo {
  name: string;
  /** Rendered declaration on one line, e.g. `string query_location();`. */
  signature: string;
  /** Visibility and storage modifiers as written, e.g. `["protected"]`. */
  modifiers: readonly string[];
}

/** Modifiers that put a declaration out of reach of code outside the file. */
const HIDDEN_MODIFIERS = new Set(["private", "protected", "static"]);

/** Whether a declaration is reachable from outside its file or class. */
export function isExported(decl: DeclInfo): boolean {
  return !decl.modifiers.some((m) => HIDDEN_MODIFIERS.has(m));
}

export interface ParsedFile {
  /** Declarations at file scope, in source order. */
  fileScope: DeclInfo[];
  /** Members of each top-level class, keyed by class name. */
  classes: Map<string, DeclInfo[]>;
}

/** Names roxenloader hands to `add_constant`, with the expression it passes. */
export interface InjectedGlobal {
  name: string;
  /** The value expression, verbatim and whitespace-collapsed. */
  valueExpr: string;
}

/** Longest signature we will emit; runaway enum bodies are not documentation. */
const MAX_SIGNATURE_LENGTH = 400;

/** Collapse a declaration's source to one line. */
function collapse(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SIGNATURE_LENGTH ? `${flat.slice(0, MAX_SIGNATURE_LENGTH)}…` : flat;
}

/** First named child of `node` with the given type. */
function child(node: Node, type: string): Node | null {
  for (const c of node.namedChildren) {
    if (c && c.type === type) return c;
  }
  return null;
}

/** Every named child of `node` with the given type. */
function children(node: Node, type: string): Node[] {
  const found: Node[] = [];
  for (const c of node.namedChildren) {
    if (c && c.type === type) found.push(c);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Declaration rendering
// ---------------------------------------------------------------------------

/**
 * Render the declaration part of a function, stopping at its body.
 *
 * module.pike's members have bodies and prototypes.pike's do not; slicing at
 * the end of the parameter list makes both read the same in hover.
 */
function renderFunction(core: Node, mods: string[], prefix: string): DeclInfo[] {
  const name = child(core, "identifier");
  const params = child(core, "parameters");
  if (!name || !params) return [];
  const type = child(core, "type");
  const head = `${type ? `${collapse(type.text)} ` : ""}${name.text}${collapse(params.text)}`;
  return [{ name: name.text, signature: collapse(`${prefix}${head};`), modifiers: mods }];
}

/** Render a variable declaration, dropping any initializer. */
function renderVariable(core: Node, mods: string[], prefix: string): DeclInfo[] {
  const type = child(core, "type");
  const typeText = type ? `${collapse(type.text)} ` : "";
  return children(core, "identifier").map((id) => ({
    name: id.text,
    signature: collapse(`${prefix}${typeText}${id.text};`),
    modifiers: mods,
  }));
}

/**
 * Render a class or enum header, stopping before its body.
 *
 * Comments are dropped rather than collapsed into the line: Roxen writes the
 * class's whole `//!` doc block between the name and the brace, and a slice
 * that keeps it turns a one-line signature into six lines of prose.
 */
function renderNamed(core: Node, mods: string[], prefix: string, bodyType: string): DeclInfo[] {
  const name = child(core, "identifier");
  if (!name) return [];
  const body = child(core, bodyType);
  const head = body ? core.text.slice(0, body.startIndex - core.startIndex) : core.text;
  const bare = head.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return [{ name: name.text, signature: collapse(`${prefix}${bare}`), modifiers: mods }];
}

/**
 * Turn one `declaration` node into the members it declares.
 *
 * Returns several entries for `int a, b;`, and none for the forms that are not
 * members at all — `inherit`, and the bare identifiers the grammar produces
 * where a preprocessor branch has cut a declaration in half.
 */
function renderDeclaration(node: Node): DeclInfo[] {
  const modifiers = children(node, "modifier").map((m) => m.text);
  const prefix = modifiers.length > 0 ? `${modifiers.join(" ")} ` : "";
  const core = node.namedChildren.filter((c): c is Node => !!c && c.type !== "modifier").at(-1);
  if (!core) return [];

  switch (core.type) {
    case "function_decl":
      return renderFunction(core, modifiers, prefix);
    case "variable_decl":
      return renderVariable(core, modifiers, prefix);
    case "class_decl":
      return renderNamed(core, modifiers, prefix, "class_body");
    case "enum_decl":
      return renderNamed(core, modifiers, prefix, "enum_body");
    case "constant_decl":
    case "typedef_decl": {
      const name = child(core, "identifier");
      if (!name) return [];
      return [{
        name: name.text,
        signature: collapse(`${prefix}${core.text}`),
        modifiers,
      }];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

/** Collect the `declaration` children of a node, rendered. */
function declarationsIn(node: Node): DeclInfo[] {
  const found: DeclInfo[] = [];
  for (const c of node.namedChildren) {
    if (!c || c.type !== "declaration") continue;
    found.push(...renderDeclaration(c));
  }
  return found;
}

/**
 * Parse one Pike source into its file-scope and per-class declarations.
 *
 * Only top-level classes get an entry: a nested class is reachable only
 * through its parent, and flattening the two would put names in scope that
 * Roxen code cannot actually write bare.
 */
export function parsePikeDeclarations(text: string, uri: string): ParsedFile {
  const root = parse(text, uri).rootNode;
  const classes = new Map<string, DeclInfo[]>();
  if (!root) return { fileScope: [], classes };

  for (const decl of root.namedChildren) {
    if (!decl || decl.type !== "declaration") continue;
    const core = decl.namedChildren.filter((c): c is Node => !!c && c.type !== "modifier").at(-1);
    if (!core || core.type !== "class_decl") continue;
    const name = child(core, "identifier");
    const body = child(core, "class_body");
    if (name && body) classes.set(name.text, declarationsIn(body));
  }

  return { fileScope: declarationsIn(root), classes };
}

// ---------------------------------------------------------------------------
// Injected globals
// ---------------------------------------------------------------------------

/**
 * Find every `add_constant("name", value)` call in a source.
 *
 * Scanned character by character rather than matched with a regular
 * expression: the value is frequently a `lambda(){ … }` whose braces, parens
 * and strings would defeat any single pattern, and a mis-terminated match
 * would silently drop the calls that follow it.
 */
export function extractAddConstantCalls(text: string): InjectedGlobal[] {
  const found: InjectedGlobal[] = [];
  const call = /\badd_constant\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = call.exec(text)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = matchingParen(text, open);
    if (close < 0) continue;
    const args = text.slice(open + 1, close);
    const name = /^\s*"((?:[^"\\]|\\.)*)"\s*,/.exec(args);
    if (!name) continue;
    found.push({
      name: name[1]!,
      valueExpr: collapse(args.slice(name[0].length)),
    });
    call.lastIndex = close;
  }
  return found;
}

/** Index of the `)` closing the `(` at `open`, or -1. String- and comment-aware. */
function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") { i = skipLiteral(text, i); continue; }
    if (ch === "/" && text[i + 1] === "/") { i = text.indexOf("\n", i); if (i < 0) return -1; continue; }
    if (ch === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i); if (i < 0) return -1; i++; continue; }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Index of the closing quote of the literal starting at `start`. */
function skipLiteral(text: string, start: number): number {
  const quote = text[start]!;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === quote) return i;
    if (text[i] === "\n") return i; // Unterminated: do not run off the file.
  }
  return text.length;
}

/**
 * The identifiers prototypes.pike excludes from becoming globals.
 *
 * roxenloader adds every index of prototypes.pike as a global constant except
 * these, so the exclusion set is read from the file rather than restated here.
 */
export function parseIgnoreIdentifiers(text: string): Set<string> {
  const multiset = /constant\s+ignore_identifiers\s*=\s*\(<([\s\S]*?)>\s*\)/.exec(text);
  if (!multiset) return new Set();
  return new Set([...multiset[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!));
}
