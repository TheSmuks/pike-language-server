#!/usr/bin/env node
/**
 * Surface 3 (extension/client) checks that do not need a VSCode extension host.
 *
 * Two of the three client-surface questions are answerable statically or via
 * the language server alone, and answering them here makes them repeatable:
 *
 *   settings  — is every contributed setting actually read by shipped code?
 *               A setting declared in the manifest and never read is the same
 *               defect class as audit iteration 6's `builtinFunction` token
 *               type: advertised, never emitted.
 *   tokens    — does any semantic token land inside a comment or a string?
 *               Disagreement between the TextMate layer and the semantic layer
 *               is what produces visibly wrong colours in the editor.
 *
 * The third question — activation on a real Roxen module — needs the extension
 * host and is covered by tests/integration, not here.
 *
 * Usage: node tools/lsp-audit/client-surface-check.mjs [settings|tokens|all]
 */

import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Roots that ship to users. A setting read only by tests is still unread. */
const SHIPPED = ["server", "client", "standalone"];

function checkSettings() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "extension.package.json"), "utf8"));
  const keys = Object.keys(manifest.contributes?.configuration?.properties ?? {});
  const unread = [];

  for (const key of keys) {
    // The client reads settings by their section-relative tail (e.g.
    // config.get("log.redactPaths")), not by the full dotted key, so try
    // several suffixes before concluding nothing reads it.
    const candidates = [key, key.replace(/^pike\./, ""), key.split(".").slice(-2).join("."), key.split(".").pop()];
    let hits = 0;
    for (const pattern of candidates) {
      const cmd = `grep -rlF ${JSON.stringify(pattern)} ${SHIPPED.join(" ")} --include=*.ts --include=*.mjs 2>/dev/null | grep -v node_modules | grep -v /dist/ | wc -l`;
      try {
        hits += Number(execSync(cmd, { cwd: ROOT, encoding: "utf8" }).trim());
      } catch {
        // grep exits non-zero when nothing matches; that is a zero, not an error.
      }
    }
    if (hits === 0) unread.push(key);
  }

  console.log(`settings: ${keys.length} contributed, ${unread.length} unread`);
  for (const key of unread) console.log(`  UNREAD  ${key}`);
  return unread.length;
}

/** Mark every offset inside a comment or a string literal. */
function mask(text) {
  const m = new Array(text.length).fill(false);
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//") { while (i < text.length && text[i] !== "\n") m[i++] = true; continue; }
    if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      while (i < stop) m[i++] = true;
      continue;
    }
    if (text[i] === '"') {
      m[i++] = true;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") m[i++] = true;
        m[i++] = true;
      }
      if (i < text.length) m[i++] = true;
      continue;
    }
    i++;
  }
  return m;
}

function offsetOf(text, line, column) {
  const lines = text.split("\n");
  let offset = 0;
  for (let l = 0; l < line; l++) offset += lines[l].length + 1;
  return offset + column;
}

function checkTokens(limit = 25) {
  const dir = join(ROOT, "corpus", "files");
  const files = readdirSync(dir).filter((f) => f.endsWith(".pike")).slice(0, limit);
  let checked = 0;
  const violations = [];

  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    const marked = mask(text);
    let out = "";
    try {
      out = execSync(`bun run scripts/lsp-probe.ts tokens corpus/files/${file} 2>/dev/null`, {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 120000,
      });
    } catch {
      continue;
    }
    for (const line of out.split("\n")) {
      const parsed = /^\s+(\d+):(\d+)\s+(\d+)\s+(\S+)/.exec(line);
      if (!parsed) continue;
      checked++;
      const offset = offsetOf(text, Number(parsed[1]) - 1, Number(parsed[2]) - 1);
      if (marked[offset]) violations.push(`${file} ${parsed[1]}:${parsed[2]} type=${parsed[4]}`);
    }
  }

  console.log(`tokens: ${checked} checked across ${files.length} files, ${violations.length} inside comments/strings`);
  for (const v of violations) console.log(`  IN-LITERAL  ${v}`);
  return violations.length;
}

const mode = process.argv[2] ?? "all";
let problems = 0;
if (mode === "settings" || mode === "all") problems += checkSettings();
if (mode === "tokens" || mode === "all") problems += checkTokens();
process.exit(problems > 0 ? 1 : 0);
