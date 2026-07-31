/**
 * Hover on the parts of a scoped access — the qualifier, the `::`, and a
 * member reached through an inherit the workspace cannot open.
 *
 * Three gaps this closes, all measured against Roxen 6.1:
 *
 * - **The qualifier keywords answered nothing.** The grammar emits `predef`,
 *   `global`, `this`, `this_program` and `local` as ANONYMOUS tokens inside
 *   `inherit_specifier`, so every tier that looks for an `identifier` node
 *   walks straight past them. `this_program::logger_name` in `Logger.pmod`
 *   hovered on the member but not on the qualifier that selects its scope.
 *
 * - **`::` itself answered nothing**, at any of the ~120 `::` sites in the
 *   tree, though one column either side of it did.
 *
 * - **A member behind an alias of a stdlib class answered nothing** once the
 *   qualifier became binding. `inherit Parser.HTML : low_parser;` names a C
 *   class with no file to index, so `low_parser::add_container` had no
 *   workspace declaration to point at — but the running Pike does know its
 *   54 members, and the worker can enumerate them.
 *
 * The keyword descriptions are what Pike 8.0.1116 actually does, not a
 * paraphrase of the manual. With `int method(){return 100;}` at file level and
 * an overriding `method` in a nested class, the compiler prints
 * `global=100 this=7 this_program=7 local=7`.
 */

import type { Hover } from "vscode-languageserver/node";
import type { Node, Tree } from "web-tree-sitter";
import type { SymbolTable } from "./symbolTable";
import { formatHover } from "./hoverContent";
import { isScopeKeyword, scopeQualifierText, inheritMatchesQualifier } from "./scopeQualifier";

/** What each scope keyword selects, in the terms a reader needs at the cursor. */
const KEYWORD_DOC: Record<string, string> = {
  predef:
    "Pike's predefined top-level scope. `predef::name` is the builtin or " +
    "module `name`, ignoring anything in this file that shadows it.",
  global:
    "The file's own top-level scope. `global::name` reaches past a class " +
    "member or local of the same name to the one declared at file level.",
  this:
    "The current object. `this::name` is the member this object sees, " +
    "including an override declared here.",
  this_program:
    "The program being compiled. `this_program::name` is this program's own " +
    "member, not an inherited one of the same name.",
  local:
    "This program's own definition, resolved non-virtually: `local::name` " +
    "keeps calling this implementation even from a program that overrides it. " +
    "Functions and constants only — Pike rejects `local::` on a variable.",
};

interface Params {
  textDocument: { uri: string };
  position: { line: number; character: number };
}

/**
 * Hover on an inherit alias — `inherit Vec : base;` on `base`, or the `base`
 * in `base::create()`. The alias is not a reference in the symbol table, so
 * the earlier tiers miss it; show the inherit it names.
 */
export function hoverFromInheritAlias(
  table: SymbolTable,
  tree: Tree,
  params: { position: { line: number; character: number } },
): Hover | null {
  const node = tree.rootNode.descendantForPosition({
    row: params.position.line, column: params.position.character,
  });
  const identName = identifierTextAt(node);
  if (!identName) return null;

  const inheritDecl = table.declarations.find(
    d => d.kind === "inherit" && d.alias === identName,
  );
  if (!inheritDecl) return null;

  return formatHover({
    name: identName,
    signature: `inherit ${inheritDecl.name} : ${identName}`,
    documentation: "",
    line: params.position.line,
    character: params.position.character,
  });
}

/** The nearest enclosing identifier's text, walking up from `node`. */
function identifierTextAt(node: Node | null): string | null {
  let current: Node | null = node;
  while (current) {
    if (current.type === "identifier" || current.type === "predef_identifier") {
      return current.text;
    }
    current = current.parent;
  }
  return null;
}

/** The `inherit_specifier` the cursor sits in, if any. */
function specifierAt(tree: Tree, line: number, character: number): Node | null {
  let node: Node | null = tree.rootNode.descendantForPosition({
    row: line, column: character,
  });
  while (node) {
    if (node.type === "inherit_specifier") return node;
    node = node.parent;
  }
  return null;
}

/**
 * Hover on a qualifier keyword or on the `::` token.
 *
 * A cursor inside `A::` where `A` is an ordinary identifier is left alone: the
 * inherit-alias tier already describes it, and it has a real declaration to
 * point at.
 */
export function hoverScopeSpecifier(
  table: SymbolTable,
  tree: Tree,
  params: Params,
): Hover | null {
  const magic = hoverMagicMember(tree, params);
  if (magic) return magic;

  const specifier = specifierAt(tree, params.position.line, params.position.character);
  if (!specifier) return null;

  const qualifier = scopeQualifierText(specifier);
  const info = { line: params.position.line, character: params.position.character };

  if (isScopeKeyword(qualifier)) {
    return formatHover({
      ...info, name: qualifier,
      signature: `${qualifier}::`,
      documentation: KEYWORD_DOC[qualifier],
    });
  }

  // Bare `::`, or the `::` of `A::`. Name what it reaches rather than
  // repeating the syntax back.
  if (qualifier === "") {
    const inherits = table.declarations
      .filter(d => d.kind === "inherit")
      .map(d => d.alias ?? d.name);
    return formatHover({
      ...info, name: "::",
      signature: "::",
      documentation: inherits.length > 0
        ? `The inherited scope. Searches ${inherits.map(n => `\`${n}\``).join(", ")}.`
        : "The inherited scope — the members of whatever this program inherits.",
    });
  }

  return null;
}

/**
 * Hover on `Alias::member` where the alias names a class outside the
 * workspace.
 *
 * Reached only after the workspace tiers have failed, so the alias is not a
 * file we can open. The static stdlib index is tried first because it carries
 * documentation; the worker's runtime resolve is the fallback for the C
 * classes the index does not describe (`Parser.HTML` among them).
 */
export async function hoverQualifiedInheritMember(
  ctx: {
    stdlibIndex: Record<string, { signature: string; markdown: string }>;
    worker: { resolve(symbol: string): Promise<ResolvedMembers> };
  },
  table: SymbolTable,
  tree: Tree,
  params: Params,
): Promise<Hover | null> {
  const target = qualifiedMemberAt(tree, params.position.line, params.position.character);
  if (!target) return null;

  const inherit = table.declarations.find(d => inheritMatchesQualifier(d, target.qualifier));
  if (!inherit) return null;

  const typeName = inherit.name.replace(/^"|"$/g, "");
  // A path, not a dotted type: that names a workspace file, and a file that
  // could be opened was already handled upstream.
  if (!typeName.includes(".") || typeName.includes("/")) return null;

  const info = { line: params.position.line, character: params.position.character };

  const entry = ctx.stdlibIndex[`predef.${typeName}.${target.member}`];
  if (entry) {
    return formatHover({
      ...info, name: target.member,
      signature: entry.signature, documentation: entry.markdown, isAutodoc: true,
    });
  }

  return workerMemberHover(ctx.worker, typeName, target.member, info);
}

interface ResolvedMembers {
  resolved: boolean;
  methods?: Array<{ name: string }>;
  constants?: Array<{ name: string }>;
  inherited_methods?: string[];
  inherited_constants?: string[];
}

/** Confirm the member exists on the resolved type, and say which type owns it. */
async function workerMemberHover(
  worker: { resolve(symbol: string): Promise<ResolvedMembers> },
  typeName: string,
  member: string,
  info: { line: number; character: number },
): Promise<Hover | null> {
  let resolved: ResolvedMembers;
  try {
    resolved = await worker.resolve(typeName);
  } catch {
    return null;
  }
  if (!resolved.resolved) return null;

  const isMethod = (resolved.methods ?? []).some(m => m.name === member) ||
    (resolved.inherited_methods ?? []).includes(member);
  const isConstant = (resolved.constants ?? []).some(c => c.name === member) ||
    (resolved.inherited_constants ?? []).includes(member);
  if (!isMethod && !isConstant) return null;

  // No signature is available — the runtime knows the name and the owner, not
  // the declared types — so say exactly that rather than inventing one.
  return formatHover({
    ...info, name: member,
    signature: isMethod ? `${typeName}.${member}()` : `${typeName}.${member}`,
    documentation: `${isMethod ? "Method" : "Constant"} of \`${typeName}\`.`,
  });
}

/**
 * Hover on `this` or `this_program` used as the MEMBER of a scoped access.
 *
 * `global::this` is the only way to name the file's own object from inside a
 * nested class, and Roxen uses it to test whether that object is still alive
 * (`RoxenDebug.pmod:106`, `Variable.pmod/module.pmod:234`). Neither is a
 * declaration anywhere, so no lookup tier can reach them.
 *
 * Pike 8.0.1116 on a file with `class Inner` inside it:
 *
 *     global::this = /main()          this = /main()->Inner()
 *     global::this_program = /main    this_program = /main()->Inner
 */
function hoverMagicMember(tree: Tree, params: Params): Hover | null {
  const node = tree.rootNode.descendantForPosition({
    row: params.position.line, column: params.position.character,
  });
  if (!node || (node.text !== "this" && node.text !== "this_program")) return null;

  const scopeExpr = node.parent;
  if (!scopeExpr || scopeExpr.type !== "scope_expr") return null;
  const specifier = scopeExpr.children.find(c => c.type === "inherit_specifier");
  if (!specifier) return null;

  const qualifier = scopeQualifierText(specifier);
  const subject = node.text === "this" ? "object" : "program";
  const owner = qualifier === "global" ? "file's own"
    : qualifier === "" ? "inherited"
    : `\`${qualifier}\``;

  return formatHover({
    line: params.position.line,
    character: params.position.character,
    name: node.text,
    signature: `${qualifier}::${node.text}`,
    documentation:
      `The ${owner} ${subject}. Inside a nested class a plain \`this\` is the ` +
      "inner object; `global::this` is the one the file itself compiles to.",
  });
}

/** The `Alias` and `member` of an `Alias::member` the cursor's member sits in. */
function qualifiedMemberAt(
  tree: Tree,
  line: number,
  character: number,
): { qualifier: string; member: string } | null {
  const node = tree.rootNode.descendantForPosition({ row: line, column: character });
  if (!node || node.type !== "identifier") return null;
  const scopeExpr = node.parent;
  if (!scopeExpr || scopeExpr.type !== "scope_expr") return null;

  const specifier = scopeExpr.children.find(c => c.type === "inherit_specifier");
  if (!specifier) return null;
  const qualifier = scopeQualifierText(specifier);
  if (qualifier === "" || isScopeKeyword(qualifier)) return null;

  return { qualifier, member: node.text };
}
