/**
 * The three harvests that Roxen's AutoDoc cannot supply.
 *
 * `build-roxen-index.ts` gets the documented API from Pike's own AutoDoc
 * extractor. That leaves three holes, each closed here by reading the Roxen
 * source rather than by naming symbols:
 *
 *   1. Prototype members with no `//!` comment. prototypes.pike's
 *      `class RoxenModule` and module.pike's file scope are mostly bare
 *      declarations, and AutoDoc skips every one of them.
 *   2. Members no prototype declares, which modules supply by convention —
 *      `cvs_version` is read off a `RoxenModule` by Roxen's own code and is
 *      declared by the modules themselves, never by the prototype.
 *   3. Globals roxenloader injects at run time, reachable as `predef::name`.
 *
 * The convention set (2) is measured, not asserted: the module corpus is
 * parsed and a name is kept only when a stated fraction of modules declare it.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeSource } from "../server/src/util/sourceDecoder";
import {
  parsePikeDeclarations,
  extractAddConstantCalls,
  parseIgnoreIdentifiers,
  isExported,
  type DeclInfo,
} from "./roxen-declarations";

export interface SymbolEntry {
  signature: string;
  markdown: string;
}

/**
 * Renders a symbol's documentation, given the file that declares it.
 *
 * Documentation only, never a signature: Pike's extractor renders the doc
 * block, but asked for the signature of a class with nested classes it can
 * answer with an inner one's — `RequestID` came back as `class CookieJar`. The
 * declaration parsed out of the source is always the declaration of the name
 * that was asked for, so that is what these harvests use.
 */
export type DocLookup = (absPath: string, symbolName: string) => string | null;

const BASE = join("server", "base_server");

/** Sources whose file scope every Roxen module inherits, via module.pike. */
const PROTOTYPE_SOURCES = [join(BASE, "module.pike"), join(BASE, "basic_defvar.pike")];

/** Sources that call `add_constant`, in the order roxenloader runs them. */
const GLOBAL_SOURCES = [join(BASE, "roxenloader.pike"), join(BASE, "roxen.pike")];

const PROTOTYPES = join(BASE, "prototypes.pike");

/** Where the shipped modules live; the corpus the convention set is measured on. */
const MODULE_CORPUS = join("server", "modules");

/**
 * Fraction of the module corpus that must declare a name for it to count as
 * part of the de-facto module surface.
 *
 * Measured at a fifth: in Roxen 6.1 the counts fall off a cliff there — nine
 * names clear it and the tenth is declared by a sixth of the corpus — so the
 * set is not sensitive to the exact figure.
 */
export const CONVENTION_THRESHOLD = 0.2;

const read = (path: string): string => decodeSource(readFileSync(path)).text;

// ---------------------------------------------------------------------------
// 1. Undocumented prototype members
// ---------------------------------------------------------------------------

/**
 * Add the prototype's declarations that AutoDoc did not cover.
 *
 * Existing entries are never overwritten: an AutoDoc-rendered entry carries
 * documentation and this one carries only a declaration, so the harvest fills
 * gaps and does not degrade what is already there.
 */
export function harvestPrototypeMembers(root: string, into: Record<string, SymbolEntry>): number {
  let added = 0;
  const add = (decl: DeclInfo): void => {
    const key = `RoxenModule.${decl.name}`;
    if (!isExported(decl) || key in into) return;
    into[key] = { signature: decl.signature, markdown: "" };
    added++;
  };

  for (const source of PROTOTYPE_SOURCES) {
    const abs = join(root, source);
    if (!existsSync(abs)) continue;
    for (const decl of parsePikeDeclarations(read(abs), `file://${abs}`).fileScope) add(decl);
  }

  const protos = join(root, PROTOTYPES);
  if (existsSync(protos)) {
    const parsed = parsePikeDeclarations(read(protos), `file://${protos}`);
    for (const decl of parsed.classes.get("RoxenModule") ?? []) add(decl);
  }
  return added;
}

// ---------------------------------------------------------------------------
// 2. Conventional members, measured on the module corpus
// ---------------------------------------------------------------------------

/** Every `.pike` under `dir`, in a stable order. */
function pikeFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) pikeFilesUnder(path, out);
    else if (path.endsWith(".pike")) out.push(path);
  }
  return out;
}

/** Count how many modules declare each file-scope name, and how they spell it. */
function tallyCorpus(dir: string): { modules: number; counts: Map<string, Map<string, number>> } {
  const counts = new Map<string, Map<string, number>>();
  let modules = 0;

  for (const file of pikeFilesUnder(dir)) {
    const text = read(file);
    if (!/^\s*inherit\s+"module"\s*;/m.test(text)) continue;
    modules++;
    const seen = new Set<string>();
    for (const decl of parsePikeDeclarations(text, `file://${file}`).fileScope) {
      if (!isExported(decl) || seen.has(decl.name)) continue;
      seen.add(decl.name);
      // Tally the declaration without its initializer: every module's
      // `constant cvs_version = "$Id: … $"` carries a different id, so counting
      // the spellings with values in them would make each one unique and the
      // most common form indistinguishable from a one-off.
      const spelling = stripInitializer(decl.signature);
      const spellings = counts.get(decl.name) ?? new Map<string, number>();
      spellings.set(spelling, (spellings.get(spelling) ?? 0) + 1);
      counts.set(decl.name, spellings);
    }
  }
  return { modules, counts };
}

/** Drop `= value` from a declaration, keeping only what is not per-module. */
function stripInitializer(signature: string): string {
  let depth = 0;
  for (let i = 0; i < signature.length; i++) {
    const ch = signature[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "=" && depth === 0 && signature[i + 1] !== "=") {
      return `${signature.slice(0, i).trimEnd()};`;
    }
  }
  return signature;
}

/** The spelling most modules use, with ties broken lexicographically. */
function modalSpelling(spellings: Map<string, number>): string {
  return [...spellings].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
}

/**
 * Add members that the corpus declares but no prototype does.
 *
 * `cvs_version` is the reason this exists: Roxen reads it off a `RoxenModule`
 * in configuration.pike, yet it is declared by each module rather than by the
 * prototype, so no amount of prototype parsing would ever find it.
 */
export function harvestConventionalMembers(
  root: string,
  into: Record<string, SymbolEntry>,
): number {
  const corpus = join(root, MODULE_CORPUS);
  if (!existsSync(corpus)) return 0;

  const { modules, counts } = tallyCorpus(corpus);
  const floor = Math.ceil(modules * CONVENTION_THRESHOLD);
  let added = 0;

  for (const [name, spellings] of counts) {
    const declared = [...spellings.values()].reduce((a, b) => a + b, 0);
    if (declared < floor) continue;
    const key = `RoxenModule.${name}`;
    if (key in into) continue;
    into[key] = {
      signature: modalSpelling(spellings),
      markdown:
        `Declared at file scope by ${declared} of the ${modules} modules shipped ` +
        `with this Roxen. Not part of the module prototype: each module supplies ` +
        `it, so the exact type and value are the module's own.`,
    };
    added++;
  }
  return added;
}

// ---------------------------------------------------------------------------
// 3. Globals injected into the Pike namespace
// ---------------------------------------------------------------------------

const INJECTED_NOTE = "Injected into Pike's namespace at run time by roxenloader.";

/**
 * Drop the signature block Pike's extractor prepends to a doc body.
 *
 * The entry already carries a signature parsed from the declaration, so the
 * block is a duplicate — and for a class with nested classes it is a wrong
 * one: `RequestID`'s doc came back headed `class CookieJar`.
 */
function withoutSignatureBlock(markdown: string): string {
  return markdown.replace(/^```pike\n[\s\S]*?\n```\n*/, "").trim();
}

/** Record one injected global, keeping whatever is already indexed. */
function addGlobal(
  into: Record<string, SymbolEntry>,
  name: string,
  entry: SymbolEntry,
): boolean {
  const key = `predef.${name}`;
  if (key in into) return false;
  const doc = withoutSignatureBlock(entry.markdown);
  into[key] = {
    signature: entry.signature,
    markdown: doc ? `${doc}\n\n${INJECTED_NOTE}` : INJECTED_NOTE,
  };
  return true;
}

/** Harvest the explicit `add_constant("name", value)` calls of one source. */
function harvestAddConstants(
  abs: string,
  into: Record<string, SymbolEntry>,
  docFor: DocLookup,
): number {
  const text = read(abs);
  const declared = new Map<string, DeclInfo>();
  for (const decl of parsePikeDeclarations(text, `file://${abs}`).fileScope) {
    if (!declared.has(decl.name)) declared.set(decl.name, decl);
  }

  const bare = /^[A-Za-z_][A-Za-z0-9_]*$/;
  let added = 0;
  for (const call of extractAddConstantCalls(text)) {
    // A dotted name is a member of some other namespace, not a bare global.
    if (!bare.test(call.name)) continue;
    // `add_constant("report_fatal", report_fatal)` names a function this file
    // declares; `add_constant("cache_set", cache->cache_set)` does not, and
    // the call itself is then the only honest thing to show.
    const local = bare.test(call.valueExpr) ? call.valueExpr : call.name;
    const decl = declared.get(local);
    const added_ = addGlobal(into, call.name, {
      signature: decl?.signature ?? `constant ${call.name} = ${call.valueExpr};`,
      markdown: docFor(abs, local) ?? "",
    });
    if (added_) added++;
  }
  return added;
}

/**
 * Harvest prototypes.pike's file scope, which roxenloader adds wholesale.
 *
 * It loops over `indices(prototypes)` and adds every one as a global constant
 * except those the file itself lists in `ignore_identifiers`, so that list is
 * read from the source rather than restated.
 */
function harvestPrototypeGlobals(
  abs: string,
  into: Record<string, SymbolEntry>,
  docFor: DocLookup,
): number {
  const text = read(abs);
  const ignored = parseIgnoreIdentifiers(text);
  let added = 0;

  for (const decl of parsePikeDeclarations(text, `file://${abs}`).fileScope) {
    if (!isExported(decl) || ignored.has(decl.name)) continue;
    const entry = { signature: decl.signature, markdown: docFor(abs, decl.name) ?? "" };
    if (addGlobal(into, decl.name, entry)) added++;
  }
  return added;
}

/**
 * Every name a Roxen file can reach as `predef::name` but Pike does not define.
 *
 * prototypes.pike goes first because it declares the classes — `RequestID`,
 * `Configuration`, `RoxenModule` — that roxen.pike then hands to
 * `add_constant` by name. Taken the other way round, the entry for
 * `RoxenModule` would have been the call's own `constant RoxenModule =
 * RoxenModule;` instead of the class it actually names.
 */
export function harvestInjectedGlobals(
  root: string,
  into: Record<string, SymbolEntry>,
  docFor: DocLookup,
): number {
  let added = 0;
  const protos = join(root, PROTOTYPES);
  if (existsSync(protos)) added += harvestPrototypeGlobals(protos, into, docFor);

  for (const source of GLOBAL_SOURCES) {
    const abs = join(root, source);
    if (existsSync(abs)) added += harvestAddConstants(abs, into, docFor);
  }
  return added;
}
