/**
 * The four harvests that Roxen's AutoDoc cannot supply.
 *
 * `build-roxen-index.ts` gets the documented API from Pike's own AutoDoc
 * extractor. That leaves four holes, each closed here by reading the Roxen
 * source rather than by naming symbols:
 *
 *   1. Prototype members with no `//!` comment. prototypes.pike's
 *      `class RoxenModule` and module.pike's file scope are mostly bare
 *      declarations, and AutoDoc skips every one of them.
 *   2. Members no prototype declares, which modules supply by convention —
 *      `cvs_version` is read off a `RoxenModule` by Roxen's own code and is
 *      declared by the modules themselves, never by the prototype.
 *   3. Globals roxenloader injects at run time, reachable as `predef::name`.
 *   4. The MEMBERS of the globals from (3) that are bound to a whole source
 *      file, which (3) records as one opaque name — `roxen` was in the index
 *      while `roxen.store` was not.
 *
 * The convention set (2) is measured, not asserted: the module corpus is
 * parsed and a name is kept only when a stated fraction of modules declare it.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { decodeSource } from "../server/src/util/sourceDecoder";
import {
  parsePikeDeclarations,
  parseFileScopeInherits,
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

/**
 * Sources that call `add_constant`, in the order roxenloader runs them.
 *
 * Only the first two run their `add_constant`s at file scope. The rest do it
 * from a function, and each was traced to the call that reaches it before
 * being listed here — an injection nothing invokes is not part of the
 * namespace, and indexing it would invent vocabulary:
 *
 * - `cache.pike` — roxenloader instantiates it
 *   (`cache=((program)"base_server/cache")();`, roxenloader.pike:833) and the
 *   file injects itself with `add_constant("cache", this_object())` at 2393.
 * - `fonts.pike` — same shape, from `roxen.pike:6671`; `create()` injects
 *   `Font`, `FontHandler`, `get_font` and four more.
 * - `config_userdb.pike` — `roxen.pike:6686` calls `init_configuserdb()`,
 *   which injects `AdminUser`.
 * - `etc/roxen_master.pike` — installed as the master by roxenloader:3972;
 *   its `create()` injects `Master` and `add_dump_constant` and calls
 *   `init_security()`, which injects `chroot`.
 *
 * Leaving them out indexed forwarded members like `cache_lookup` while the
 * object they hang off — the one `VFS.pmod:119` writes as `predef::cache` —
 * was absent.
 */
const GLOBAL_SOURCES = [
  join(BASE, "roxenloader.pike"),
  join(BASE, "roxen.pike"),
  join(BASE, "cache.pike"),
  join(BASE, "fonts.pike"),
  join(BASE, "config_userdb.pike"),
  join("server", "etc", "roxen_master.pike"),
];

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

/**
 * Named the loader for as long as roxenloader was the only source. It is not:
 * `chroot` comes from the master, `get_font` from `fonts.pike`, `AdminUser`
 * from `config_userdb.pike`. Say what is true of all of them instead of
 * crediting a file that did not do it.
 */
const INJECTED_NOTE = "Injected into Pike's namespace at run time by Roxen's startup.";

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

// ---------------------------------------------------------------------------
// 4. Members of a global bound to a whole source file
// ---------------------------------------------------------------------------

/**
 * The value expression that binds a global to the file it is written in.
 *
 * `add_constant("roxen", this_object())` makes the global *be* roxen.pike's
 * object, so that file's own file-scope declarations are the global's members.
 * Any other value expression names something this file does not define, whose
 * members are therefore not derivable from it.
 */
const SELF_BINDING_VALUE = "this_object()";

/** A member of a program, with the source that actually declares it. */
interface ProgramMember {
  decl: DeclInfo;
  /** Declaring file, relative to the Roxen root — the entry's origin note. */
  source: string;
}

/**
 * Every member of the program a source compiles to, inherits included.
 *
 * `roxen.store` is the reason this follows inherits at all: roxen.pike does
 * not declare `store`, it inherits global_variables.pike, which inherits
 * read_config.pike, which does. Four files down the chain and the audit's
 * named case.
 *
 * Resolution is Pike's: a later inherit shadows an earlier one and the file's
 * own declaration shadows both, which is why this overwrites rather than
 * keeping the first hit. Visited files are tracked across the whole walk
 * rather than per branch — Roxen's sources contain inherit cycles, and a file
 * reached twice through a diamond declares the same members either way.
 */
function programMembers(
  root: string,
  source: string,
  seen: Set<string>,
): Map<string, ProgramMember> {
  const members = new Map<string, ProgramMember>();
  const abs = join(root, source);
  if (seen.has(source) || !existsSync(abs)) return members;
  seen.add(source);

  const text = read(abs);
  for (const inherited of parseFileScopeInherits(text, `file://${abs}`)) {
    const inheritedSource = join(dirname(source), `${inherited}.pike`);
    for (const entry of programMembers(root, inheritedSource, seen)) {
      members.set(entry[0], entry[1]);
    }
  }
  for (const decl of parsePikeDeclarations(text, `file://${abs}`).fileScope) {
    if (isExported(decl)) members.set(decl.name, { decl, source });
  }
  return members;
}

/**
 * Members of the globals roxenloader binds to an entire source file.
 *
 * Harvest 3 records such a global as one opaque name, which is why the index
 * carried `roxen` and nothing under it: `constant store = roxen.store;` in
 * configuration.pike — and 61 more requests after a `.` in the behavioural
 * audit — resolved to nothing at all.
 *
 * Which globals qualify is read out of the source rather than listed: a call
 * whose value expression is literally `this_object()` is one. In Roxen 6.1
 * exactly two are, `roxen` and `roxenloader`, and both have real dotted
 * consumers in Roxen's own tree.
 *
 * Keyed `roxen.store`, dotted, because that is the form the reference is
 * written in and the form the dotted lookup is handed.
 */
export function harvestGlobalObjectMembers(
  root: string,
  into: Record<string, SymbolEntry>,
  docFor: DocLookup,
): number {
  let added = 0;
  for (const source of GLOBAL_SOURCES) {
    const abs = join(root, source);
    if (!existsSync(abs)) continue;
    const bound = extractAddConstantCalls(read(abs))
      .filter((call) => call.valueExpr === SELF_BINDING_VALUE)
      .map((call) => call.name);
    if (bound.length === 0) continue;

    const members = programMembers(root, source, new Set());
    for (const global of bound) {
      for (const [name, member] of members) {
        const key = `${global}.${name}`;
        if (key in into) continue;
        // Names the declaring file: hover cannot offer a location for a
        // bundled entry, and with a chain this deep the file is the only way
        // left to go read the source.
        const note = `Member of \`${global}\` (${member.source}).`;
        const doc = withoutSignatureBlock(docFor(join(root, member.source), name) ?? "");
        into[key] = { signature: member.decl.signature, markdown: doc ? `${doc}\n\n${note}` : note };
        added++;
      }
    }
  }
  return added;
}
