// ---------------------------------------------------------------------------
// signatureHelp-resolve.ts: Signature resolution logic
// Extracted from signatureHelp.ts to reduce file size.
// ---------------------------------------------------------------------------
import type { SymbolTable, Declaration } from "./symbolTable";
import type { SignatureContext, SignatureInfo, ParameterInfo } from "./signatureHelp";
import { containsRange } from "./scopeBuilder";
import { resolveTypeName } from "./symbolTable";
import { findDeclInScopeAt } from "./query";
import { stripScopeWrapper, stripAttributes } from "../util/stripScope";
import { positiveFunctionGroups } from "./predefTypeGroups";
import { findClassScope } from "./typeResolver";

// ---------------------------------------------------------------------------
// Main resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a callee name to a signature.
 *
 * Resolution order:
 * 1. Local function/method declaration
 * 2. Method on resolved type (if objectName is provided)
 * 3. Class constructor (ClassName → create method)
 * 4. Stdlib
 */
export function resolveSignature(
  calleeName: string,
  objectName: string | null,
  table: SymbolTable,
  stdlibIndex?: Record<string, { signature: string; markdown: string }>,
  ctx?: SignatureContext,
  /** Line of the call site, so the receiver is resolved in ITS scope. */
  callLine?: number,
): SignatureInfo | null {
  // 1. Method on a resolved receiver: obj->method(
  //
  //    Ahead of the bare-name search, for the reason a qualified path goes
  //    ahead of it everywhere else: `db->query` is that object's query, not
  //    any `query` the file happens to declare. Searching by name first let a
  //    module-private wrapper win over the method actually being called, with
  //    the answer decided by declaration order rather than by scope.
  if (objectName && ctx) {
    const methodSig = resolveMethodOnType(objectName, calleeName, table, ctx, callLine);
    if (methodSig) return methodSig;
  }

  // 2. Local function/method declaration, by bare name.
  const funcDecl = table.declarations.find(
    d => d.name === calleeName && d.kind === "function",
  );

  if (funcDecl) {
    return buildSignatureFromDecl(funcDecl, table);
  }

  // 3. Constructor: ClassName(
  //    Look for a class named calleeName, then find its create method.
  const classDecl = table.declarations.find(
    d => d.name === calleeName && d.kind === "class",
  );
  if (classDecl) {
    const constructorSig = resolveConstructor(classDecl, table, ctx);
    if (constructorSig) return constructorSig;
  }

  // 3b. Cross-file constructor: if the class is not in the current file,
  //     search the workspace index for it (handles inherited classes from
  //     other modules, e.g. Cache.Storage.Base).
  if (!classDecl && ctx?.index) {
    const crossFileType = resolveTypeSync(calleeName, table, ctx);
    if (crossFileType) {
      const constructorSig = resolveConstructor(crossFileType.decl, crossFileType.table, ctx);
      if (constructorSig) return constructorSig;
    }
  }

  // 4. Stdlib
  if (stdlibIndex) {
    const entry = stdlibIndex[`predef.${calleeName}`];
    if (entry) {
      return buildSignatureFromStdlib(calleeName, entry);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Method resolution on type
// ---------------------------------------------------------------------------

/**
 * Resolve a method on an object's type.
 *
 * Given `obj->method(`, resolve `obj`'s declared type, find the class
 * declaration for that type, and look up `method` in its class scope.
 */
function resolveMethodOnType(
  objectName: string,
  methodName: string,
  table: SymbolTable,
  ctx: SignatureContext,
  callLine?: number,
): SignatureInfo | null {
  // Find the object's declaration
  const objDecl = findDeclarationForName(table, objectName, callLine);
  if (!objDecl) return null;

  // Resolve the object's type name
  const typeName = resolveTypeName(objDecl);
  if (!typeName) return null;

  // Resolve the type to a class declaration
  const typeResult = resolveTypeSync(typeName, table, ctx);
  if (!typeResult) return null;

  // Find the class BODY scope.
  //
  // This used to look for a class scope whose declarations include the class
  // declaration itself — but a class scope holds the class's MEMBERS, while the
  // class declaration lives in the scope that encloses it (usually file scope).
  // The lookup therefore never matched, resolveMethodOnType always returned
  // null, and every `obj->method(` fell through to the bare-name search, which
  // answered with whichever same-named function the file declared first.
  const classScope = findClassScope(typeResult.table, typeResult.decl);
  if (!classScope) return null;

  // Look for the method in the class scope (and inherited scopes)
  const methodDecl = findMethodInClassScope(typeResult.table, classScope, methodName);
  if (!methodDecl) return null;

  return buildSignatureFromDecl(methodDecl, typeResult.table);
}

/** Synchronous type resolution — checks same-file and cross-file index. */
function resolveTypeSync(
  typeName: string,
  table: SymbolTable,
  ctx: SignatureContext,
): { decl: Declaration; table: SymbolTable } | null {
  // Same-file: find a class declaration with this name
  const classDecl = table.declarations.find(
    d => d.name === typeName && d.kind === "class",
  );
  if (classDecl) {
    return { decl: classDecl, table };
  }

  // Cross-file: look up in workspace index
  if (ctx.index) {
    const uris = ctx.index.getAllUris();
    for (const uri of uris) {
      const targetTable = ctx.index.getSymbolTable(uri);
      if (!targetTable) continue;
      const targetDecl = targetTable.declarations.find(
        d => d.name === typeName && d.kind === "class",
      );
      if (targetDecl) {
        return { decl: targetDecl, table: targetTable };
      }
    }
  }

  return null;
}

/** Find a method declaration in a class scope or its inherited scopes. */
function findMethodInClassScope(
  table: SymbolTable,
  classScope: import("./symbolTable").Scope,
  methodName: string,
): Declaration | null {
  // Direct members
  for (const declId of classScope.declarations) {
    const decl = table.declById.get(declId);
    if (decl && decl.name === methodName && (decl.kind === "function" || decl.kind === "method")) {
      return decl;
    }
  }

  // Inherited scopes
  for (const inheritedScopeId of classScope.inheritedScopes) {
    const inheritedScope = table.scopeById.get(inheritedScopeId);
    if (!inheritedScope) continue;
    const found = findMethodInClassScope(table, inheritedScope, methodName);
    if (found) return found;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Constructor resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a constructor for a class declaration.
 *
 * Looks for a `create` method in the class scope. Also checks cross-file
 * classes via the workspace index.
 */
export function resolveConstructor(
  classDecl: Declaration,
  table: SymbolTable,
  ctx?: SignatureContext,
): SignatureInfo | null {
  // Find the class scope by range overlap (the class decl is in the file
  // scope, not the class scope — the class scope contains the members).
  const classScope = table.scopes.find(
    s => s.kind === "class" && containsRange(s.range, classDecl.range),
  );
  if (!classScope) return null;

  // Look for the create method
  const createDeclId = classScope.declarations.find(id => {
    const decl = table.declById.get(id);
    return decl?.name === "create" && decl.kind === "function";
  });

  if (createDeclId !== undefined) {
    const createDecl = table.declById.get(createDeclId);
    if (createDecl) {
      const sig = buildSignatureFromDecl(createDecl, table);
      if (sig) return sig;
    }
  }

  // Check inherited scopes for create
  for (const inheritedScopeId of classScope.inheritedScopes) {
    const inheritedScope = table.scopeById.get(inheritedScopeId);
    if (!inheritedScope) continue;
    const inheritedCreateId = inheritedScope.declarations.find(id => {
      const decl = table.declById.get(id);
      return decl?.name === "create" && decl.kind === "function";
    });
    if (inheritedCreateId !== undefined) {
      const createDecl = table.declById.get(inheritedCreateId);
      if (createDecl) {
        return buildSignatureFromDecl(createDecl, table);
      }
    }
  }

  // No create method found — return a no-args constructor signature
  return {
    label: `${classDecl.name}()`,
    parameters: [],
  };
}

/**
 * Find a declaration by name, preferring the one visible at `line`.
 *
 * The whole-file `find` this used to do ignored scope entirely, so the first
 * declaration in document order won: a `string b` parameter inside an unrelated
 * class method shadowed the local `Box b` at the call site, the receiver's type
 * came back as `string`, and signature help fell through to whichever
 * same-named function the file declared first.
 *
 * `line` is optional because not every caller has a position; without one the
 * old whole-file behaviour is the only thing available.
 */
export function findDeclarationForName(
  table: SymbolTable,
  name: string,
  line?: number,
): Declaration | null {
  if (line !== undefined) {
    const inScope = findDeclInScopeAt(table, name, line);
    if (inScope) return inScope;
  }
  return table.declarations.find(d => d.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// Signature builders
// ---------------------------------------------------------------------------

/**
 * Collect parameter labels from a scope's parameter declarations.
 */
function collectParamLabels(table: SymbolTable, scopeId: number): ParameterInfo[] {
  const scope = table.scopes.find(s => s.id === scopeId);
  if (!scope) return [];
  const params: ParameterInfo[] = [];
  for (const declId of scope.declarations) {
    const param = table.declById.get(declId);
    if (param && param.kind === "parameter") {
      // `string ... parts`, not `string parts` — the ellipsis is the difference
      // between "takes exactly two arguments" and "takes one or more".
      const spread = param.varargs ? "... " : "";
      const label = param.declaredType
        ? `${param.declaredType} ${spread}${param.name}`
        : `${spread}${param.name}`;
      params.push({ label });
    }
  }
  return params;
}

/**
 * Build a SignatureInfo from a local function declaration.
 */
export function buildSignatureFromDecl(decl: Declaration, table: SymbolTable): SignatureInfo | null {
  const containingScope = table.scopes.find(s => s.declarations.includes(decl.id));
  if (!containingScope) {
    return { label: `${decl.declaredType ?? "mixed"} ${decl.name}(...)`, parameters: [] };
  }

  // Find the function's own scope — child of containingScope with kind "function"
  // whose range overlaps with the declaration range.
  let funcScopeId: number | null = null;
  for (const scope of table.scopes) {
    if (scope.parentId === containingScope.id && scope.kind === "function" &&
        scope.range.start.line <= decl.range.end.line && scope.range.end.line >= decl.range.start.line) {
      funcScopeId = scope.id;
      break;
    }
  }

  const params = funcScopeId !== null
    ? collectParamLabels(table, funcScopeId)
    : collectParamLabels(table, containingScope.id);

  const retType = decl.declaredType ?? "mixed";
  return { label: `${retType} ${decl.name}(${params.map(p => p.label).join(", ")})`, parameters: params };
}

/**
 * Build a SignatureInfo from a stdlib autodoc entry.
 */
export function buildSignatureFromStdlib(
  name: string,
  entry: { signature: string; markdown: string },
): SignatureInfo {
  // Parse parameters from the signature
  const sig = entry.signature;
  const openParen = sig.indexOf("(");
  const closeParen = sig.lastIndexOf(")");

  const params: ParameterInfo[] = [];
  if (openParen !== -1 && closeParen !== -1) {
    const paramText = sig.slice(openParen + 1, closeParen).trim();
    if (paramText) {
      const parts = splitParams(paramText);
      for (const part of parts) {
        params.push({ label: part.trim() });
      }
    }
  }

  return {
    label: sig,
    documentation: entry.markdown,
    parameters: params,
  };
}

// ---------------------------------------------------------------------------
// Predef (efun) signatures
// ---------------------------------------------------------------------------

/**
 * Build signatures for a predef builtin (efun) like `write` or `sprintf`.
 *
 * Efuns are absent from the stdlib autodoc index; their signatures live in
 * predef-builtin-index.json as raw Pike type descriptors of the form
 * `scope(0,function(string : int) | function(array(string), mixed ... : int))`.
 * Each `function(args : ret)` alternative becomes one overload. Markdown
 * documentation comes from predef-autodoc.json when available.
 */
export function resolvePredefSignatures(
  calleeName: string,
  ctx?: SignatureContext,
): SignatureInfo[] {
  const raw = ctx?.predefBuiltins?.[calleeName];
  if (!raw) return [];

  const markdown = ctx?.predefAutodoc?.[calleeName]?.markdown;
  const signatures: SignatureInfo[] = [];

  const seen = new Set<string>();
  for (const group of positiveFunctionGroups(stripScopeWrapper(raw))) {
    const inner = stripAttributes(group.slice(1, -1));
    // `params : returnType` — find the top-level colon separator.
    const colonIdx = topLevelIndexOf(inner, ":");
    const paramText = (colonIdx === -1 ? inner : inner.slice(0, colonIdx)).trim();
    const returnType = colonIdx === -1 ? "mixed" : inner.slice(colonIdx + 1).trim();

    const params: ParameterInfo[] = paramText === "" || paramText === "void"
      ? []
      : splitParams(paramText).map(p => ({ label: p.trim() }));

    const label = `${returnType} ${calleeName}(${params.map(p => p.label).join(", ")})`;
    // The soft-alternative form repeats the same call shape in several
    // constraint branches; showing it three times helps nobody.
    if (seen.has(label)) continue;
    seen.add(label);

    signatures.push({ label, documentation: markdown, parameters: params });
  }

  return signatures;
}

/** Index of the first occurrence of `ch` at paren/brace/bracket depth 0. */
function topLevelIndexOf(text: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split parameter text by commas, respecting nested parentheses.
 */
export function splitParams(text: string): string[] {
  const result: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      result.push(text.slice(start, i));
      start = i + 1;
    }
  }

  if (start < text.length) {
    result.push(text.slice(start));
  }

  return result;
}
