#!/usr/bin/env bun
/**
 * Wrong-answer oracle for go-to-definition.
 *
 * The existing audit sweep measures whether navigation answers *something*. It
 * cannot see a confident answer that points at the wrong place — which is the
 * failure users actually report ("it opened an include at a random line").
 *
 * This sweep checks one invariant that needs no Pike oracle and no snapshot:
 *
 *   If CTRL+CLICK on the identifier `N` answers location L, then the text at L
 *   must be `N`.
 *
 * A target whose text is not the identifier that was clicked is wrong by
 * construction — whatever the intended answer was, it is not there.
 *
 * Usage:  bun run tools/lsp-audit/wrong-target-sweep.ts [--root <dir>] [--limit N]
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { decodeSource } from "../../server/src/util/sourceDecoder";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createTestServer, waitForFileEntry } from "../../tests/lsp/helpers";
import { initParser, parse } from "../../server/src/parser";
import { buildSymbolTable } from "../../server/src/features/symbolTable";


interface LspLocation {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

type Verdict =
  | { kind: "ok" }
  | { kind: "empty" }
  | { kind: "whole-file" }
  | { kind: "quoted-target"; got: string }
  | { kind: "wrong-column"; reason: string; got: string }
  | { kind: "wrong"; reason: string; got: string };

function flag(name: string, fallback: string): string {
  const argv = process.argv;
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

function pikeFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const path = join(dir, entry);
      let isDir = false;
      try { isDir = statSync(path).isDirectory(); } catch { continue; }
      if (isDir) walk(path);
      else if (/\.(pike|pmod|h)$/.test(entry)) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

/** Cache of target-file lines, keyed by URI. */
const lineCache = new Map<string, string[] | null>();
function linesOf(uri: string): string[] | null {
  if (lineCache.has(uri)) return lineCache.get(uri)!;
  let value: string[] | null = null;
  try {
    value = decodeSource(readFileSync(fileURLToPath(uri))).text.split("\n");
  } catch {
    value = null;
  }
  lineCache.set(uri, value);
  return value;
}

/**
 * Judge one answer against the invariant.
 *
 * A location of 0:0-0:0 is the server's "the target is this whole file"
 * answer (a module, or a file that is implicitly a class) and carries no
 * position to check.
 */
function judge(name: string, loc: LspLocation): Verdict {
  const r = loc.range;
  if (r.start.line === 0 && r.start.character === 0 &&
      r.end.line === 0 && r.end.character === 0) {
    return { kind: "whole-file" };
  }

  const lines = linesOf(loc.uri);
  if (!lines) return { kind: "wrong", reason: "target file unreadable", got: loc.uri };

  if (r.start.line >= lines.length) {
    return {
      kind: "wrong",
      reason: `line ${r.start.line} past end of file (${lines.length} lines)`,
      got: "<out of bounds>",
    };
  }

  const line = lines[r.start.line];
  const got = line.slice(r.start.character, r.start.character + name.length);
  if (got === name) return { kind: "ok" };

  // `inherit "other.pike";` names its target with a string literal, so an
  // inherit declaration's own range is quoted text, not a bare identifier.
  const wider = line.slice(r.start.character, r.end.character);
  if (/^["'`]/.test(wider) || /^["'`]/.test(got)) {
    return { kind: "quoted-target", got: wider };
  }

  // The identifier IS on the answered line, just not at the answered column.
  // The editor still opens the right place; the cursor lands beside it.
  if (new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[^A-Za-z0-9_]/g, "\\$&")}([^A-Za-z0-9_]|$)`).test(line)) {
    return {
      kind: "wrong-column",
      reason: `identifier is on the line at column ${line.indexOf(name)}, answer said ${r.start.character}`,
      got: JSON.stringify(line.trim().slice(0, 60)),
    };
  }

  return {
    kind: "wrong",
    reason: "clicked identifier is nowhere on the answered line",
    got: `${JSON.stringify(wider)} (line ${r.start.line}: ${JSON.stringify(line.trim().slice(0, 60))})`,
  };
}

async function main(): Promise<void> {
  const root = resolve(flag("root", "corpus/files"));
  const limit = Number(flag("limit", "0"));
  await initParser();

  let files = pikeFiles(root);
  if (limit > 0) files = files.slice(0, limit);
  console.error(`sweeping ${files.length} files under ${root}`);

  const server = await createTestServer({ rootUri: pathToFileURL(root).href });
  const uris: string[] = [];
  for (const path of files) {
    const uri = pathToFileURL(path).href;
    let text: string;
    try { text = decodeSource(readFileSync(path)).text; } catch { continue; }
    server.openDoc(uri, text);
    uris.push(uri);
  }
  try {
    await waitForFileEntry(server, uris, 120_000);
  } catch (err) {
    console.error(`warning: ${(err as Error).message}`);
  }

  const counts = new Map<string, number>();
  const wrong: string[] = [];
  // Every probe's outcome, for before/after diffing. A fix that trades a wrong
  // answer for no answer is progress; one that trades a RIGHT answer for no
  // answer is a regression, and only a full record can tell them apart.
  const all: string[] = [];
  let probes = 0;

  for (const path of files) {
    const uri = pathToFileURL(path).href;
    let text: string;
    try { text = decodeSource(readFileSync(path)).text; } catch { continue; }
    const tree = parse(text, uri);
    if (!tree) continue;
    const table = buildSymbolTable(tree, uri, 1, undefined, text);

    for (const ref of table.references) {
      // Probe the middle of the identifier — the position a click lands on.
      const character = ref.loc.character + Math.floor(ref.name.length / 2);
      probes++;
      let result: LspLocation | LspLocation[] | null;
      try {
        result = await server.client.sendRequest("textDocument/definition", {
          textDocument: { uri },
          position: { line: ref.loc.line, character },
        }) as LspLocation | LspLocation[] | null;
      } catch (err) {
        counts.set("request-error", (counts.get("request-error") ?? 0) + 1);
        continue;
      }
      const key = `${path.replace(root + "/", "")}:${ref.loc.line}:${ref.loc.character} ${ref.name}`;
      if (result === null || (Array.isArray(result) && result.length === 0)) {
        counts.set("empty", (counts.get("empty") ?? 0) + 1);
        all.push(`${key}\tempty\t-`);
        continue;
      }
      // An array answer is the references list the server returns when the
      // cursor sits on a declaration's own name; judge every entry.
      const locs = Array.isArray(result) ? result : [result];
      for (const loc of locs) {
        const verdict = judge(ref.name, loc);
        counts.set(verdict.kind, (counts.get(verdict.kind) ?? 0) + 1);
        all.push(
          `${key}\t${verdict.kind}\t${loc.uri.replace(pathToFileURL(root).href + "/", "")}` +
          `:${loc.range.start.line}:${loc.range.start.character}`,
        );
        if (verdict.kind === "wrong" || verdict.kind === "wrong-column") {
          wrong.push(
            `[${verdict.kind}] ${path.replace(root + "/", "")}:${ref.loc.line + 1} click "${ref.name}" -> ` +
            `${loc.uri.replace(pathToFileURL(root).href + "/", "")}:${loc.range.start.line + 1} ` +
            `[${verdict.reason}] got ${verdict.got}`,
          );
        }
      }
    }
  }

  await server.teardown();

  console.log(`\nprobes: ${probes}`);
  for (const [kind, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind}: ${n}`);
  }
  const dumpAll = flag("dumpall", "");
  if (dumpAll) {
    writeFileSync(dumpAll, all.join("\n") + "\n");
    console.log(`\nwrote ${all.length} probe outcomes to ${dumpAll}`);
  }
  const dump = flag("dump", "");
  if (dump) {
    writeFileSync(dump, wrong.join("\n") + "\n");
    console.log(`\nwrote ${wrong.length} suspect answers to ${dump}`);
  }
  console.log(`\nSUSPECT TARGETS: ${wrong.length}`);
  for (const w of wrong.slice(0, 40)) console.log(`  ${w}`);
  if (wrong.length > 40) console.log(`  ... and ${wrong.length - 40} more`);
}

await main();
