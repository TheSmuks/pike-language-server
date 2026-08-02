#!/usr/bin/env node
/**
 * Settings and commands extraction/comparison for client-surface-check.mjs.
 *
 * Split out of client-surface-check.mjs to keep files and functions within
 * the Tiger Style limits (files <=500 lines, functions <=50 lines).
 *
 * Both checks here are two-directional:
 *   settings  — declared-but-unread (forward) AND read-but-undeclared (reverse).
 *   commands  — declared-but-unregistered (forward) AND registered-but-
 *               undeclared (reverse, modulo an explicit internal allowlist).
 *
 * The previous settings check only went forward and matched on a
 * last-dotted-segment ("path", "mode", "enabled"), which almost anything
 * matches — "0 unread" proved nothing. This version matches on the full
 * dotted key, extracted structurally from the actual `config.get(...)`
 * call sites rather than fuzzy substring search, so there is no degraded
 * tail to accidentally satisfy.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, extname } from "node:path";

/** Commands invoked programmatically (e.g. from a server code lens) rather
 *  than surfaced in the command palette — legitimately registered without
 *  being declared in contributes.commands. */
export const INTERNAL_COMMAND_ALLOWLIST = new Set(["pike.showReferences"]);

const SKIP_DIRS = new Set(["node_modules", "dist", ".vscode-test", ".git"]);

/** Recursively collect files under `dir` whose extension is in `exts`. */
export function walkFiles(dir, exts) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, exts));
    } else if (exts.includes(extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** Read the manifest and return { settingsKeys, commands }. */
export function readManifest(root) {
  const manifest = JSON.parse(readFileSync(join(root, "extension.package.json"), "utf8"));
  const settingsKeys = new Set(Object.keys(manifest.contributes?.configuration?.properties ?? {}));
  const commands = new Set((manifest.contributes?.commands ?? []).map((c) => c.command));
  return { settingsKeys, commands };
}

/** varName -> config section, from `const NAME = vscode.workspace.getConfiguration("SECTION")`. */
function extractConfigVarSections(text) {
  const map = new Map();
  const re = /(?:const|let|var)\s+(\w+)\s*=\s*vscode\.workspace\.getConfiguration\(\s*["']([\w.]+)["']\s*\)/g;
  let m;
  while ((m = re.exec(text))) map.set(m[1], m[2]);
  return map;
}

/**
 * Full dotted setting keys actually read in `text`, via either:
 *   const config = vscode.workspace.getConfiguration("pike.languageServer");
 *   config.get<T>("worker.ldLibraryPath", ...)
 * or the direct chained form:
 *   vscode.workspace.getConfiguration("pike.languageServer").get<T>("path", ...)
 */
function extractStructuredConfigReads(text) {
  const keys = new Set();
  const varSections = extractConfigVarSections(text);

  const callRe = /\b(\w+)\.get(?:<[^>]*>)?\(\s*["']([\w.]+)["']/g;
  let m;
  while ((m = callRe.exec(text))) {
    const section = varSections.get(m[1]);
    if (section) keys.add(`${section}.${m[2]}`);
  }

  const chainRe = /getConfiguration\(\s*["']([\w.]+)["']\s*\)\s*\.get(?:<[^>]*>)?\(\s*["']([\w.]+)["']/g;
  while ((m = chainRe.exec(text))) keys.add(`${m[1]}.${m[2]}`);

  return keys;
}

/** Full dotted "pike.languageServer.X" / "pike.roxen.X" literals mentioned anywhere
 *  (log messages, doc comments, or reads outside the structured getConfiguration idiom). */
function extractLiteralMentions(text) {
  const keys = new Set();
  const re = /pike\.(?:languageServer|roxen)\.[A-Za-z][\w.]*/g;
  let m;
  while ((m = re.exec(text))) keys.add(m[0].replace(/[.,;:'"]+$/, ""));
  return keys;
}

/** Union of every setting key read anywhere under `client/` (structural +
 *  literal) and `server/src/` (literal only — server never calls
 *  vscode.workspace.getConfiguration; it receives initializationOptions). */
export function collectReadSettingKeys(root) {
  const keys = new Set();
  for (const file of walkFiles(join(root, "client"), [".ts"])) {
    const text = readFileSync(file, "utf8");
    for (const k of extractStructuredConfigReads(text)) keys.add(k);
    for (const k of extractLiteralMentions(text)) keys.add(k);
  }
  for (const file of walkFiles(join(root, "server", "src"), [".ts"])) {
    const text = readFileSync(file, "utf8");
    for (const k of extractLiteralMentions(text)) keys.add(k);
  }
  return keys;
}

/** Command ids registered via registerCommand/registerTextEditorCommand in `client/`. */
export function collectRegisteredCommands(root) {
  const ids = new Set();
  const re = /register(?:TextEditorCommand|Command)\(\s*["'](pike\.[\w.]+)["']/g;
  for (const file of walkFiles(join(root, "client"), [".ts"])) {
    const text = readFileSync(file, "utf8");
    let m;
    while ((m = re.exec(text))) ids.add(m[1]);
  }
  return ids;
}
