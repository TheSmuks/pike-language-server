/**
 * color-debug.mjs — render a Pike sample under a real VS Code color theme, the
 * way the editor actually paints it, to debug syntax coloring.
 *
 * It tokenizes the sample with vscode-oniguruma + vscode-textmate (the exact
 * engine VS Code uses), applies a theme's `tokenColors` + `semanticTokenColors`,
 * layers our language server's semantic tokens on top the way VS Code resolves
 * them, and emits a side-by-side HTML report. Characters where a semantic token
 * downgrades a grammar-colored token to the theme's default foreground (the
 * "color vanished" effect) are flagged as regressions.
 *
 * Usage:
 *   bun run scripts/color-debug.mjs --theme <theme.json> [--compare <grammar>] \
 *     [--file <sample.pike>] [--out <out.html>]
 *
 * --theme    Path to a VS Code color theme JSON (with tokenColors). Required.
 * --compare  Path to a second TextMate grammar (.tmLanguage plist or .json) to
 *            render alongside ours for comparison. Optional.
 * --file     Pike sample to render. Defaults to the built-in snippet.
 * --out      Output HTML path. Defaults to ./color-debug.html.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as oniguruma from "vscode-oniguruma";
import * as vsctm from "vscode-textmate";
import { Parser, Language } from "web-tree-sitter";
import { buildSymbolTable } from "../server/src/features/symbolTable";
import { produceSemanticTokens, TOKEN_TYPES } from "../server/src/features/semanticTokens";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const themePath = arg("theme");
if (!themePath) { console.error("error: --theme <theme.json> is required"); process.exit(2); }
const comparePath = arg("compare");
const outPath = arg("out", resolve(process.cwd(), "color-debug.html"));
const DEFAULT_SAMPLE = `#include <stdio.h>
#define MAX 10

#if 0
  // legacy path — disabled, kept for reference
#endif

class Counter {
  private int count = 0;
  constant string NAME = "counter";
  int add(int delta, mapping(string:int) opts) {
    count += delta;
    if (delta > MAX) return -1;
    return count;
  }
}

int main(int argc, array(string) argv) {
  Counter c = Counter();
  int total = 0;
  foreach (argv, string arg) total += c->add(sizeof(arg), ([ "verbose": 1 ]));
  write("total=%d\\n", total);
  return total;
}
`;
const filePath = arg("file");
const source = filePath ? readFileSync(filePath, "utf8") : DEFAULT_SAMPLE;

const theme = JSON.parse(readFileSync(themePath, "utf8"));
const EDITOR_FG = (theme.colors && theme.colors["editor.foreground"]) || "#cccccc";
const EDITOR_BG = (theme.colors && theme.colors["editor.background"]) || "#1e1e1e";

await oniguruma.loadWASM(readFileSync(resolve(ROOT, "node_modules/vscode-oniguruma/release/onig.wasm")).buffer);
const onigLib = Promise.resolve({
  createOnigScanner: (p) => new oniguruma.OnigScanner(p),
  createOnigString: (s) => new oniguruma.OnigString(s),
});
const themeSettings = [{ settings: { foreground: EDITOR_FG, background: EDITOR_BG } }, ...(theme.tokenColors || [])];

async function tmColors(grammarPath, isPlist) {
  const reg = new vsctm.Registry({
    onigLib,
    theme: { settings: themeSettings },
    loadGrammar: async () => vsctm.parseRawGrammar(readFileSync(grammarPath, "utf8"), isPlist ? "g.tmLanguage" : "g.json"),
  });
  const grammar = await reg.loadGrammar("source.pike");
  const colorMap = reg.getColorMap();
  let stack = vsctm.INITIAL;
  return source.split("\n").map((line) => {
    const r = grammar.tokenizeLine2(line, stack);
    const spans = [];
    for (let i = 0; i < r.tokens.length; i += 2) {
      const start = r.tokens[i];
      const end = i + 2 < r.tokens.length ? r.tokens[i + 2] : line.length;
      const fgId = (r.tokens[i + 1] >> 15) & 511;
      spans.push({ text: line.slice(start, end), color: colorMap[fgId] || EDITOR_FG });
    }
    stack = r.ruleStack;
    return spans;
  });
}

// Resolve a candidate scope list to a theme color (first scope with a rule wins).
function scopeToColor(scopeList) {
  for (const scope of scopeList) {
    let best = null, bestLen = -1;
    for (const rule of theme.tokenColors || []) {
      const sels = Array.isArray(rule.scope) ? rule.scope : (rule.scope ? rule.scope.split(",").map((s) => s.trim()) : []);
      for (const sel of sels) {
        if ((scope === sel || scope.startsWith(sel + ".")) && sel.length > bestLen && rule.settings?.foreground) {
          best = rule.settings.foreground; bestLen = sel.length;
        }
      }
    }
    if (best) return best;
  }
  return null;
}

// Our contributed semanticTokenScopes fallback (keep in sync with extension.package.json).
const SEM_SCOPES = {
  class: ["entity.name.type.class"], enum: ["entity.name.type.enum", "entity.name.type"],
  enumMember: ["constant.other.enum", "variable.other.enummember"],
  function: ["support.function.any-method", "entity.name.function"],
  method: ["support.function.any-method", "variable.other.property", "entity.name.function.member"],
  variable: ["variable.other", "variable"], parameter: ["variable.parameter"],
  type: ["entity.name.type", "storage.type"], namespace: ["entity.other.inherited-class", "entity.name.namespace"],
  builtinFunction: ["support.function.builtin", "support.function"],
};
function semanticColor(typeName) {
  const stc = theme.semanticTokenColors || {};
  if (stc[typeName]) return typeof stc[typeName] === "string" ? stc[typeName] : stc[typeName].foreground;
  const c = SEM_SCOPES[typeName] && scopeToColor(SEM_SCOPES[typeName]);
  return c || EDITOR_FG;
}

await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(resolve(ROOT, "server/tree-sitter-pike.wasm")));
const table = buildSymbolTable(parser.parse(source), "file:///sample.pike", 1, undefined, source);
const semTokens = produceSemanticTokens(table);

function mergeSemantic(tmLines, counters) {
  const byLine = new Map();
  for (const t of semTokens) {
    const typeName = TOKEN_TYPES[t.typeId];
    (byLine.get(t.line) || byLine.set(t.line, []).get(t.line)).push({ char: t.character, len: t.length, typeName, color: semanticColor(typeName) });
  }
  return source.split("\n").map((_, ln) => {
    const chars = [];
    for (const span of tmLines[ln]) for (const ch of span.text) chars.push({ ch, tm: span.color, color: span.color, sem: null, regress: false });
    for (const s of byLine.get(ln) || []) {
      for (let i = s.char; i < s.char + s.len && i < chars.length; i++) {
        const c = chars[i];
        c.regress = c.tm.toLowerCase() !== EDITOR_FG.toLowerCase() && s.color.toLowerCase() === EDITOR_FG.toLowerCase();
        if (c.regress && c.ch.trim()) counters.regress++;
        c.color = s.color; c.sem = s;
      }
    }
    const spans = [];
    for (const c of chars) {
      const last = spans[spans.length - 1];
      if (last && last.color === c.color && !!last.regress === !!c.regress) last.text += c.ch;
      else spans.push({ text: c.ch, color: c.color, regress: c.regress, sem: c.sem });
    }
    return spans;
  });
}

const oursTM = await tmColors(resolve(ROOT, "client/syntaxes/pike.tmLanguage.json"), false);
const theirsTM = comparePath ? await tmColors(resolve(comparePath), comparePath.endsWith(".json") ? false : true) : null;
const counters = { regress: 0 };
const oursSem = mergeSemantic(oursTM, counters);

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function col(tag, title, lines, note, badge) {
  let h = `<section class="col"><header class="colhead"><span class="tag">${tag}</span><h2>${title}</h2><p class="note">${note}</p>${badge || ""}</header><pre>`;
  for (const spans of lines) {
    for (const sp of spans) {
      const cls = sp.regress ? ` class="regress"` : "";
      const tip = sp.sem ? ` title="semantic '${sp.sem.typeName}' → ${sp.color}"` : "";
      h += `<span style="color:${sp.color}"${cls}${tip}>${esc(sp.text)}</span>`;
    }
    h += "\n";
  }
  return h + "</pre></section>";
}
const badge = counters.regress > 0
  ? `<span class="badge bad">${counters.regress} char${counters.regress === 1 ? "" : "s"} flattened</span>`
  : `<span class="badge ok">no regressions</span>`;
const cols = [
  col("1", "Our grammar", oursTM, "TextMate only — semantic OFF", ""),
  theirsTM ? col("2", "Their grammar", theirsTM, "comparison grammar — TextMate only", "") : "",
  col("3", "Ours + semantic", oursSem, "semantic ON, our server + theme resolution", badge),
].join("\n");

writeFileSync(outPath, `<style>
  :root{--bg:${EDITOR_BG};--fg:${EDITOR_FG};--panel:#232a36;--panel2:#1b212b;--line:#39435530;--muted:#8a94a6;--accent:#73d0ff;--bad:#ff6b6b;--sans:ui-sans-serif,system-ui,sans-serif;--mono:ui-monospace,Menlo,Consolas,monospace}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans)}
  main{max-width:1400px;margin:0 auto;padding:32px 24px 48px}
  .hero{max-width:70ch;margin-bottom:28px}.eyebrow{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 10px}
  h1{font-size:clamp(22px,3vw,30px);line-height:1.15;font-weight:650;margin:0 0 12px;text-wrap:balance}
  .lede{font-size:14.5px;line-height:1.6;color:#c2c0b8;margin:0}
  code{font-family:var(--mono);font-size:.88em;background:#0f141b80;padding:.05em .35em;border-radius:4px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:16px}
  .col{background:linear-gradient(180deg,var(--panel),var(--panel2));border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .colhead{padding:14px 16px 12px;border-bottom:1px solid var(--line)}
  .tag{display:inline-block;font-family:var(--mono);font-size:11px;font-weight:600;color:var(--bg);background:var(--accent);border-radius:5px;padding:1px 7px;margin-bottom:8px}
  h2{font-size:15px;font-weight:600;margin:0}.note{font-size:12px;color:var(--muted);margin:3px 0 0}
  .badge{display:inline-block;margin-top:9px;font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px}
  .badge.bad{color:#ffd7d7;background:#ff6b6b26;border:1px solid #ff6b6b55}.badge.ok{color:#bff0d0;background:#4fd08726;border:1px solid #4fd08755}
  pre{margin:0;padding:14px 16px;font-family:var(--mono);font-size:12.5px;line-height:1.65;white-space:pre;overflow-x:auto}
  .regress{background:#ff333322;outline:1px solid var(--bad);border-radius:3px;padding:0 1px}
  .foot{margin-top:22px;font-size:12px;color:var(--muted);border-top:1px solid var(--line);padding-top:14px}
</style>
<main>
  <header class="hero">
    <p class="eyebrow">Pike syntax coloring · diagnostic</p>
    <h1>Same file, colored under ${esc(theme.name || themePath.split("/").pop())}</h1>
    <p class="lede">Rendered with <code>vscode-oniguruma</code> + <code>vscode-textmate</code> — the engine VS&nbsp;Code paints with. A <span class="regress">red box</span> marks a regression: the grammar gave that text a color, but a semantic token overwrote it with the theme's default foreground <code>${EDITOR_FG}</code>.</p>
  </header>
  <div class="grid">${cols}</div>
  <footer class="foot">Semantic tokens: ${semTokens.length}. Hover a token for its semantic type. Regenerate after grammar/collector changes to compare.</footer>
</main>`);
console.log(`semantic tokens: ${semTokens.length} | regressions: ${counters.regress} | wrote ${outPath}`);
