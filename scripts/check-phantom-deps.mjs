#!/usr/bin/env node
/**
 * Guard against "phantom dependencies": a package imported by first-party
 * source but absent from the lockfile that resolves that source.
 *
 * This is the exact failure that broke CI in July 2026 — a test imported
 * `vscode-oniguruma`/`vscode-textmate`, which existed only in a developer's
 * local node_modules and were never declared in package.json / bun.lock. The
 * author's machine passed; CI's `--frozen-lockfile` install lacked them.
 *
 * We validate against the *lockfile's resolved package set*, not package.json,
 * so legitimately-hoisted transitive imports (e.g. vscode-languageserver-
 * protocol, pulled in by vscode-languageserver) are allowed, while a package
 * that resolves nowhere is rejected. A file is checked against every bun.lock
 * at or above its directory, so the nested tests/integration package (its own
 * bun.lock) resolves independently from the root.
 *
 * Run: node scripts/check-phantom-deps.mjs   (exits non-zero on a violation)
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, resolve, sep } from "node:path";

const readFile = (p) => readFileSync(p, "utf8");

/** Drop comments so prose like `// walk back from '('` isn't read as an import.
 *  Import statements never carry a `//` before their specifier, so trimming
 *  each line at `//` cannot truncate a real import. */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

// Names that never appear in a lockfile but are always resolvable.
const BUILTINS = new Set(builtinModules);
const isBuiltin = (name) => BUILTINS.has(name) || name.startsWith("node:");
// `vscode` is the ambient extension-host module (typed via @types/vscode);
// `bun` / `bun:*` are the Bun runtime. None are npm packages.
const isAmbient = (name) => name === "vscode" || name === "bun" || name.startsWith("bun:");

/** Reduce an import specifier to its package name (@scope/name or name). */
function packageName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Every resolved package name recorded in a bun.lock's entries. */
function lockPackageNames(lockPath) {
  const names = new Set();
  const text = readFile(lockPath);
  // Each package entry's resolved id looks like "name@version" or
  // "@scope/name@version"; capture the name portion regardless of nesting key.
  const re = /"((?:@[^"/]+\/)?[^"@/][^"@]*)@[^"]+"/g;
  let m;
  while ((m = re.exec(text)) !== null) names.add(m[1]);
  return names;
}

/** Bare import/require/export-from specifiers appearing in source text.
 *  Module specifiers never contain whitespace, so [^"'\s]+ keeps these tight
 *  and prevents matches from straying across quotes/newlines into code text. */
function importSpecifiers(text) {
  const specs = [];
  const patterns = [
    /\bfrom\s*["']([^"'\s]+)["']/g, //          import … from "y" | export … from "y"
    /\bimport\s*["']([^"'\s]+)["']/g, //        import "y" (side-effect)
    /\brequire\(\s*["']([^"'\s]+)["']\s*\)/g, // require("y")
    /\bimport\(\s*["']([^"'\s]+)["']\s*\)/g, //  import("y")
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) specs.push(m[1]);
  }
  return specs;
}

const root = process.cwd();
const trackedLocks = execFileSync("git", ["ls-files", "*bun.lock"], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const lockDirs = trackedLocks.map((rel) => ({
  dir: dirname(resolve(root, rel)),
  names: lockPackageNames(resolve(root, rel)),
}));

/** Union of package names from every lockfile at or above `fileDir`. */
function availableFor(fileDir) {
  const names = new Set();
  for (const { dir, names: set } of lockDirs) {
    if (fileDir === dir || fileDir.startsWith(dir + sep)) {
      for (const n of set) names.add(n);
    }
  }
  return names;
}

const sourceFiles = execFileSync(
  "git",
  ["ls-files", "*.ts", "*.mts", "*.cts", "*.js", "*.mjs", "*.cjs"],
  { encoding: "utf8" },
)
  .split("\n")
  .filter((f) => f && !f.endsWith(".d.ts"));

const violations = [];
for (const rel of sourceFiles) {
  const abs = resolve(root, rel);
  const available = availableFor(dirname(abs));
  const seen = new Set();
  for (const spec of importSpecifiers(stripComments(readFile(abs)))) {
    if (spec.startsWith(".") || spec.startsWith("/")) continue;
    if (isBuiltin(spec) || isAmbient(spec)) continue;
    const pkg = packageName(spec);
    if (isBuiltin(pkg) || isAmbient(pkg)) continue;
    if (available.has(pkg) || seen.has(pkg)) continue;
    seen.add(pkg);
    violations.push({ file: rel, pkg, spec });
  }
}

if (violations.length > 0) {
  console.error("Phantom dependencies — imported but not in any applicable bun.lock:\n");
  for (const v of violations) {
    console.error(`  ${v.file}: '${v.pkg}'${v.pkg === v.spec ? "" : ` (from '${v.spec}')`}`);
  }
  console.error(
    "\nAdd the package to the appropriate package.json and run `bun install`,\n" +
      "or remove the import. A package present only in local node_modules will\n" +
      "break CI's --frozen-lockfile install.",
  );
  process.exit(1);
}

console.log(`check-phantom-deps: ${sourceFiles.length} source files clean.`);
