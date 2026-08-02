/**
 * Runtime reconciliation for the bundled stdlib index — the pike binary is
 * the oracle for module members. Used only by build-stdlib-index.ts, at
 * index-generation time; the LSP never needs Pike for this data.
 *
 * AutoDoc extraction sees one source file at a time, so on its own the index
 * (a) leaks source-level symbols that are not indexable from outside the
 * module (protected declarations, macros, inactive #ifdef blocks) and
 * (b) misses members a module re-exports from C modules (`inherit _Stdio;`)
 * or provides via sibling files (Stdio.pmod/Readline.pike). The runtime
 * applies Pike's actual visibility rules and inherit expansion, so each
 * module's direct children are reconciled against it here.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface OracleMember {
  /** Basic runtime type from sprintf("%t", value) — "program", "function", … */
  t: string;
  /** Full type descriptor from sprintf("%O", _typeof(value)). */
  type: string;
}

interface OracleModule {
  kind: "module" | "program" | "unavailable";
  members?: Record<string, OracleMember>;
}

export type OracleData = Record<string, OracleModule>;

// Two stdin modes:
//   {"mode":"modules","paths":[…]} — classify each path and list a module's
//     indices() with per-member types.
//   {"mode":"probe","paths":[…]} — for each dotted path, report whether
//     master()->resolv() answers. This matches what compiling `Path;` does
//     (verified on Stdio._Stdio, Crypto.None, String.low_fuzzymatch), and is
//     the authority for removals: indices() under-reports on joined modules,
//     so a member absent there can still be genuinely indexable.
const ORACLE_PIKE_SCRIPT = `
mapping describe_module(mixed val) {
  array(string) names;
  if (catch { names = indices(val); }) return (["kind": "unavailable"]);
  mapping(string:mapping(string:string)) members = ([]);
  foreach (names, string name) {
    string bt = "mixed";
    string t = "mixed";
    catch {
      mixed member = val[name];
      bt = sprintf("%t", member);
      t = sprintf("%O", _typeof(member));
    };
    members[name] = ([ "t": bt, "type": t ]);
  }
  return ([ "kind": "module", "members": members ]);
}

int main() {
  mapping request = Standards.JSON.decode(Stdio.stdin->read());
  string mode = request->mode;
  array(string) paths = request->paths;
  mapping out = ([]);
  foreach (paths, string path) {
    mixed val;
    int threw = !!catch { val = master()->resolv(path); };
    if (mode == "probe") {
      out[path] = (threw || undefinedp(val)) ? "fail" : "ok";
      continue;
    }
    if (threw || undefinedp(val)) { out[path] = (["kind": "unavailable"]); continue; }
    if (!objectp(val)) { out[path] = (["kind": "program"]); continue; }
    out[path] = describe_module(val);
  }
  write("%s", Standards.JSON.encode(out));
  return 0;
}
`;

/** Every dotted prefix (sans "predef.") the index claims members under. */
export function collectModuleParents(index: Record<string, unknown>): string[] {
  const parents = new Set<string>();
  for (const fqn of Object.keys(index)) {
    const parts = fqn.split(".");
    if (parts.length < 3 || parts[0] !== "predef") continue;
    for (let end = 2; end < parts.length; end++) {
      parents.add(parts.slice(1, end).join("."));
    }
  }
  return [...parents].sort();
}

/** One oracle invocation. See ORACLE_PIKE_SCRIPT for the two modes. */
function runOracle(mode: "modules" | "probe", paths: string[]): unknown {
  const dir = mkdtempSync(join(tmpdir(), "stdlib-oracle-"));
  const scriptPath = join(dir, "module-oracle.pike");
  try {
    writeFileSync(scriptPath, ORACLE_PIKE_SCRIPT, "utf-8");
    const stdout = execFileSync("pike", [scriptPath], {
      input: JSON.stringify({ mode, paths }),
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf-8",
    });
    return JSON.parse(stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Ask the real pike binary for the indexable members of each module path. */
export function runModuleOracle(modulePaths: string[]): OracleData {
  return runOracle("modules", modulePaths) as OracleData;
}

/** The subset of dotted paths master()->resolv() cannot answer. */
function probeNonIndexable(paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const results = runOracle("probe", paths) as Record<string, string>;
  return new Set(paths.filter((p) => results[p] !== "ok"));
}

/** Split at top-level occurrences of any delimiter char, keeping delimiters. */
function splitKeepingDelims(s: string, delims: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && delims.includes(ch)) {
      parts.push(s.slice(start, i), ch);
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

/** End index of the group opened at `open` (position of the closing paren). */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return s.length - 1;
}

/**
 * Sort `|` union members at every nesting depth. Pike's runtime prints union
 * members in an order that varies between processes, which made the generated
 * type strings — and therefore the index file — differ run to run. Unions are
 * order-insignificant, so the sorted spelling is equivalent; strings without
 * a union pass through untouched.
 */
function canonicalizeType(type: string): string {
  if (!type.includes("|")) return type;
  const unionParts = splitKeepingDelims(type, "|");
  if (unionParts.length > 1) {
    const members = unionParts
      .filter((_, idx) => idx % 2 === 0)
      .map((part) => canonicalizeType(part.trim()))
      .sort();
    return members.join(" | ");
  }
  let out = "";
  let i = 0;
  while (i < type.length) {
    if (type[i] === "(") {
      const close = matchParen(type, i);
      const inner = splitKeepingDelims(type.slice(i + 1, close), ",:");
      out += "(" + inner
        .map((piece, idx) => (idx % 2 === 0 ? canonicalizeType(piece.trim()) : piece))
        .join("") + ")";
      i = close + 1;
    } else {
      out += type[i];
      i++;
    }
  }
  return out;
}

/** Synthesize an index entry for a runtime member the harvest never saw. */
function synthesizeEntry(
  name: string,
  member: OracleMember,
): { signature: string; markdown: string } {
  let signature: string;
  if (member.t === "program") {
    signature = `class ${name}`;
  } else if (member.t === "function") {
    const canonical = canonicalizeType(member.type);
    const type = canonical.length > 160
      ? `${canonical.slice(0, 160)}…`
      : canonical;
    signature = `${type} ${name}`;
  } else if (member.t === "int" || member.t === "string" || member.t === "float") {
    signature = `constant ${name}`;
  } else if (member.t === "object") {
    signature = `object ${name}`;
  } else {
    signature = `${member.t} ${name}`;
  }
  return { signature, markdown: "```pike\n" + signature + "\n```" };
}

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export type StdlibIndex = Record<string, { signature: string; markdown: string }>;

export interface ReconcileResult {
  added: string[];
  removed: string[];
  /** Modules resolvable but gutted on this host (missing C core) — left as harvested. */
  skipped: string[];
  /** Modules that did not resolv at all on this host — left as harvested. */
  unavailable: string[];
}

/** Identifier-named direct children of each FQN prefix. */
function identifierChildrenByParent(index: StdlibIndex): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const fqn of Object.keys(index)) {
    const dot = fqn.lastIndexOf(".");
    const parent = fqn.slice(0, dot);
    const child = fqn.slice(dot + 1);
    if (!IDENTIFIER_RE.test(child)) continue;
    let set = map.get(parent);
    if (!set) map.set(parent, (set = new Set()));
    set.add(child);
  }
  return map;
}

/**
 * A module whose harvested children mostly vanished at runtime is not full of
 * phantoms — it compiled with its C core absent on this host (GLUE without GL,
 * Java without a JVM, Regexp.PCRE without libpcre), so `#if constant(…)`
 * guards stripped the real surface. Pruning there would silently destroy the
 * autodoc for every user whose Pike has the library. Below half survival the
 * module is treated as host-degraded and left exactly as harvested.
 */
function isHostDegraded(existing: Set<string>, members: Record<string, OracleMember>): boolean {
  if (existing.size === 0) return false;
  let surviving = 0;
  for (const child of existing) {
    if (child in members) surviving++;
  }
  return surviving / existing.size < 0.5;
}

/**
 * Make each healthy oracle-answered module's direct children match the
 * runtime: prune children the runtime cannot index (each removal individually
 * confirmed by a resolv probe — indices() under-reports on joined modules,
 * e.g. Crypto.None), add the members the harvest missed, and record the
 * module under a `reconciled.` key so completion knows the bundled set is
 * authoritative for it. Returns what changed for logging and for the
 * shrink-guard exemption.
 */
export function reconcileWithRuntime(index: StdlibIndex, oracle: OracleData): ReconcileResult {
  const result: ReconcileResult = { added: [], removed: [], skipped: [], unavailable: [] };
  const childrenByParent = identifierChildrenByParent(index);
  const candidates: Array<{ modulePath: string; child: string }> = [];

  for (const [modulePath, info] of Object.entries(oracle)) {
    if (info.kind === "unavailable") { result.unavailable.push(modulePath); continue; }
    if (info.kind !== "module") continue;
    const members = info.members ?? {};
    const existing = childrenByParent.get(`predef.${modulePath}`) ?? new Set<string>();
    if (isHostDegraded(existing, members)) { result.skipped.push(modulePath); continue; }

    for (const child of existing) {
      if (!(child in members)) candidates.push({ modulePath, child });
    }
    for (const [name, member] of Object.entries(members)) {
      if (existing.has(name) || !IDENTIFIER_RE.test(name)) continue;
      const fqn = `predef.${modulePath}.${name}`;
      index[fqn] = synthesizeEntry(name, member);
      result.added.push(fqn);
    }
    index[`reconciled.${modulePath}`] = { signature: "module", markdown: "" };
  }

  const confirmed = probeNonIndexable(candidates.map((c) => `${c.modulePath}.${c.child}`));
  for (const { modulePath, child } of candidates) {
    if (!confirmed.has(`${modulePath}.${child}`)) continue;
    removeSubtree(index, `predef.${modulePath}.${child}`, result.removed);
  }
  return result;
}

/** Delete an FQN and every key beneath it, recording each removal. */
function removeSubtree(index: StdlibIndex, fqn: string, removed: string[]): void {
  if (fqn in index) {
    delete index[fqn];
    removed.push(fqn);
  }
  const subtree = `${fqn}.`;
  for (const key of Object.keys(index)) {
    if (key.startsWith(subtree)) {
      delete index[key];
      removed.push(key);
    }
  }
}
