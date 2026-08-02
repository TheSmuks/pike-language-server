#!/usr/bin/env node
/**
 * Surface 3 (extension/client) checks that do not need a VSCode extension host.
 *
 *   settings  — is every contributed setting actually read by shipped code,
 *               AND is every setting shipped code reads actually declared
 *               in the manifest? Both directions matter: a setting declared
 *               and never read is dead surface (audit iteration 6's
 *               `builtinFunction` token defect class); a setting read but
 *               never declared is invisible in Settings UI and silently
 *               falls back to `config.get`'s default forever.
 *   commands  — is every contributed command actually registered, AND is
 *               every registered `pike.*` command either declared or an
 *               acknowledged internal command (invoked programmatically,
 *               e.g. from a server code lens, never from the palette)?
 *   tokens    — does any semantic token land inside a comment or a string?
 *               Disagreement between the TextMate layer and the semantic
 *               layer is what produces visibly wrong colours in the editor.
 *
 * The fourth question — activation on a real Roxen module — needs the
 * extension host and is covered by tests/integration, not here.
 *
 * Matching is on the FULL dotted setting key (or, for the legacy grep path
 * inside checkTokens' violations, full identifiers) — never a last-segment
 * degradation like "path" or "enabled", which nearly everything matches and
 * so proves nothing. See client-surface-lib.mjs for the extraction.
 *
 * Usage: node tools/lsp-audit/client-surface-check.mjs [settings|commands|tokens|all]
 */

import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readManifest,
  collectReadSettingKeys,
  collectRegisteredCommands,
  INTERNAL_COMMAND_ALLOWLIST,
} from "./client-surface-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function checkSettings(root = ROOT) {
  const { settingsKeys } = readManifest(root);
  const readKeys = collectReadSettingKeys(root);

  const unread = [...settingsKeys].filter((k) => !readKeys.has(k)).sort();
  const undeclared = [...readKeys]
    .filter((k) => k.startsWith("pike.") && !settingsKeys.has(k))
    .sort();

  console.log(`settings: ${settingsKeys.size} declared, ${readKeys.size} read, ${unread.length} unread, ${undeclared.length} undeclared`);
  for (const key of unread) console.log(`  UNREAD       ${key}`);
  for (const key of undeclared) console.log(`  UNDECLARED   ${key}`);
  return unread.length + undeclared.length;
}

export function checkCommands(root = ROOT) {
  const { commands } = readManifest(root);
  const registered = collectRegisteredCommands(root);

  const unregistered = [...commands].filter((c) => !registered.has(c)).sort();
  const undeclared = [...registered]
    .filter((c) => !commands.has(c) && !INTERNAL_COMMAND_ALLOWLIST.has(c))
    .sort();

  console.log(`commands: ${commands.size} declared, ${registered.size} registered, ${unregistered.length} unregistered, ${undeclared.length} undeclared`);
  for (const c of unregistered) console.log(`  UNREGISTERED ${c}`);
  for (const c of undeclared) console.log(`  UNDECLARED   ${c}`);
  return unregistered.length + undeclared.length;
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

/** Run the token probe for one file. Returns { out } on success or throws —
 *  a probe crash is a check failure, never a silently-skipped file. */
function runTokenProbe(root, file) {
  const out = execSync(`bun run scripts/lsp-probe.ts tokens corpus/files/${file} 2>&1`, {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
  });
  return out;
}

export function checkTokens(limit = 25, root = ROOT) {
  const dir = join(root, "corpus", "files");
  const files = readdirSync(dir).filter((f) => f.endsWith(".pike")).slice(0, limit);
  let checked = 0;
  const violations = [];
  const probeFailures = [];

  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    const marked = mask(text);
    let out;
    try {
      out = runTokenProbe(root, file);
    } catch (err) {
      // A probe crash must not read as "nothing to report" — it's a
      // counted failure with a message, not a silent skip.
      probeFailures.push(`${file}: probe failed — ${err.message.split("\n")[0]}`);
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

  console.log(`tokens: ${checked} checked across ${files.length} files, ${violations.length} inside comments/strings, ${probeFailures.length} probe failures`);
  for (const v of violations) console.log(`  IN-LITERAL    ${v}`);
  for (const f of probeFailures) console.log(`  PROBE-FAILED  ${f}`);
  return violations.length + probeFailures.length;
}

// Only run the CLI when this file is executed directly (`node
// client-surface-check.mjs`), not when it's imported for its exported
// check functions (e.g. by a scratch-copy verification harness) — an
// unconditional process.exit() here would kill the importing process
// before it ever got control back.
const isMain = import.meta.url === `file://${resolve(process.argv[1] ?? "")}`;
if (isMain) {
  const mode = process.argv[2] ?? "all";
  let problems = 0;
  if (mode === "settings" || mode === "all") problems += checkSettings();
  if (mode === "commands" || mode === "all") problems += checkCommands();
  if (mode === "tokens" || mode === "all") problems += checkTokens();
  process.exit(problems > 0 ? 1 : 0);
}
