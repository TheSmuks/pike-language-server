/**
 * corpus-manifest.ts — Corpus manifest management tool.
 *
 * Reads corpus/files/, corpus/corpus.json, and corpus/manifest.md.
 * Updates manifest.md to reflect the current on-disk state.
 *
 * Usage:
 *   bun run scripts/manifest.ts [--dry-run] [--sync]
 *
 * --dry-run  Print what would change without writing anything.
 * --sync     Write the updated manifest.md (default: dry-run).
 */

import { resolve, join } from "node:path";
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Project root
// ---------------------------------------------------------------------------

function findProjectRoot(start: string = import.meta.dir): string {
  let dir = start;
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not find project root (no package.json found)");
}

const ROOT = findProjectRoot();
const CORPUS_FILES = join(ROOT, "corpus", "files");
const CORPUS_JSON = join(ROOT, "corpus", "corpus.json");
const MANIFEST_MD = join(ROOT, "corpus", "manifest.md");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunnerOptions {
  strict?: boolean;
  modulePath?: string;
  includePath?: string;
}

interface CorpusManifest {
  $schema?: string;
  description?: string;
  files: Record<string, RunnerOptions>;
}

interface FileEntry {
  filename: string;
  category: string;
  feature: string;
  priority: "P0" | "P1" | "P2";
  status: "Valid" | "Error" | "Valid*";
  isNew: boolean;
  isPlanned: boolean;
  runnerOpts?: RunnerOptions;
}

interface CategorySection {
  title: string;
  priority: "P0" | "P1" | "P2";
  entries: FileEntry[];
}

// ---------------------------------------------------------------------------
// Category classification
// ---------------------------------------------------------------------------

const CATEGORY_PATTERNS: Array<{ prefix: string; category: string; priority: "P0" | "P1" | "P2" }> = [
  ["basic-",    "Basic types and variables",             "P0"],
  ["class-",    "Classes and inheritance",              "P0"],
  ["fn-",       "Functions and closures",                "P0"],
  ["import-",   "Imports and modules",                  "P0"],
  ["err-",      "Error cases",                          "P0"],
  ["autodoc-",  "AutoDoc documentation",                "P0"],
  ["mod-",      "Modifier combinations",               "P0"],
  ["stdlib-",   "Standard library usage",               "P0"],
  ["cpp-",      "Preprocessor",                         "P0"],
  ["enum-",     "Enums and constants",                 "P0"],
  ["cross-",    "Cross-file references",                "P1"],
  ["compat-",   "Compatibility",                        "P1"],
  ["inference-","Type inference",                       "P1"],
  ["scope-",    "Scoping",                              "P1"],
  ["rename-",   "Rename testing",                       "P1"],
  ["constant-", "Enums and constants",                  "P1"],
  ["nested-",   "Scoping",                              "P1"],
];

function classifyFile(filename: string): { category: string; feature: string; priority: "P0" | "P1" | "P2" } {
  for (const [prefix, category, priority] of CATEGORY_PATTERNS) {
    if (filename.startsWith(prefix)) {
      const rest = filename.slice(prefix.length).replace(/\.pike$/, "").replace(/-/g, " ");
      return { category, feature: capitalise(rest), priority };
    }
  }
  return { category: "Miscellaneous", feature: filename, priority: "P1" };
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Parse existing manifest.md
// ---------------------------------------------------------------------------

interface ParsedManifest {
  /** Files that appear in the committed table, keyed by filename. */
  committed: Map<string, FileEntry>;
  /** Planned entries from the Planned section. */
  planned: Map<string, { feature: string; priority: "P1" | "P2" }>;
  /** The full lines of the original file. */
  lines: string[];
}

/**
 * Parse the existing manifest.md.
 *
 * Structure: multiple `### Category` sections, each followed by a table.
 * The tables are separated by blank lines and the next ### or ## header.
 * We find every "### " and "## " line, then for each find its nearest
 * subsequent table header "| # | File |" and parse rows until the next
 * section or end of file.
 */
function parseManifestMd(content: string): ParsedManifest {
  const lines = content.split("\n");
  const committed = new Map<string, FileEntry>();
  const planned = new Map<string, { feature: string; priority: "P1" | "P2" }>();

  // Find all section header lines (1-based positions)
  type SectionMarker = { depth: "h2" | "h3"; lineIdx: number; title: string };
  const sections: SectionMarker[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("### ")) {
      sections.push({ depth: "h3", lineIdx: i, title: l.slice(4).trim() });
    } else if (l.startsWith("## ")) {
      sections.push({ depth: "h2", lineIdx: i, title: l.slice(3).trim() });
    }
  }

  // For each section, find its table and parse rows
  for (let si = 0; si < sections.length; si++) {
    const section = sections[si];
    const nextSectionLine = si + 1 < sections.length ? sections[si + 1].lineIdx : lines.length;

    // Find table header within this section's range
    let tableHeaderIdx = -1;
    for (let i = section.lineIdx; i < nextSectionLine; i++) {
      if (lines[i].includes("| # | File |")) { tableHeaderIdx = i; break; }
    }
    if (tableHeaderIdx === -1) continue;

    // Parse table rows until next section or blank line after last row
    for (let i = tableHeaderIdx + 2; i < nextSectionLine; i++) {
      const l = lines[i].trim();
      if (!l || l.startsWith("#")) break;  // blank or next section
      const cols = l.split("|").map(c => c.trim()).filter(Boolean);
      if (cols.length < 5) continue;
      const filename = cols[1].replace(/`/g, "");
      const feature = cols[2];
      const priority = cols[3] as "P0" | "P1" | "P2";
      const status = cols[4] as "Valid" | "Error" | "Valid*";
      committed.set(filename, { filename, category: "", feature, priority, status, isNew: false, isPlanned: false });
    }
  }

  // Planned section: locate it and parse its table
  const plannedSectionIdx = lines.findIndex(l => l.startsWith("## Planned but Not Yet Created"));
  if (plannedSectionIdx !== -1) {
    const summaryLineIdx = lines.findIndex(l => l.startsWith("## Summary"), plannedSectionIdx + 1);
    const tableHeaderIdx = lines.findIndex((l, i) => i > plannedSectionIdx && l.includes("| File |"));
    if (tableHeaderIdx !== -1) {
      const endIdx = summaryLineIdx !== -1 ? summaryLineIdx : lines.length;
      for (let i = tableHeaderIdx + 2; i < endIdx; i++) {
        const l = lines[i].trim();
        if (!l || l.startsWith("#")) break;
        const cols = l.split("|").map(c => c.trim()).filter(Boolean);
        if (cols.length < 3) continue;
        const filename = cols[1].replace(/`/g, "");
        const feature = cols[2];
        const priority = (cols[3] ?? "P1") as "P1" | "P2";
        planned.set(filename, { feature, priority });
      }
    }
  }

  return { committed, planned, lines };
}

// ---------------------------------------------------------------------------
// Load corpus.json
// ---------------------------------------------------------------------------

function loadCorpusJson(): Record<string, RunnerOptions> {
  if (!existsSync(CORPUS_JSON)) return {};
  try {
    const raw = JSON.parse(readFileSync(CORPUS_JSON, "utf-8")) as CorpusManifest;
    return raw.files ?? {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Scan corpus/files
// ---------------------------------------------------------------------------

function scanCorpusFiles(): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(CORPUS_FILES, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith(".pike") || entry.name.endsWith(".pmod"))) {
      results.push(entry.name);
    }
  }
  return results.sort();
}

// ---------------------------------------------------------------------------
// Build updated entries from on-disk files
// ---------------------------------------------------------------------------

function buildEntries(
  onDisk: string[],
  parsed: ParsedManifest,
  corpusJson: Record<string, RunnerOptions>,
): FileEntry[] {
  return onDisk.map(filename => {
    const existing = parsed.committed.get(filename);
    const plannedEntry = parsed.planned.get(filename);
    const runnerOpts = corpusJson[filename];

    if (existing) {
      return { ...existing, runnerOpts };
    }
    const { category, feature, priority } = classifyFile(filename);
    return {
      filename,
      category,
      feature: plannedEntry?.feature ?? feature,
      priority: (plannedEntry?.priority ?? priority) as "P0" | "P1" | "P2",
      status: "Valid",
      isNew: !plannedEntry,
      isPlanned: !!plannedEntry,
      runnerOpts,
    };
  });
}

// ---------------------------------------------------------------------------
// Group entries by category (in display order)
// ---------------------------------------------------------------------------

const CATEGORY_ORDER: Array<[string, "P0" | "P1" | "P2"]> = [
  ["Basic types and variables",             "P0"],
  ["Classes and inheritance",              "P0"],
  ["Functions and closures",               "P0"],
  ["Imports and modules",                  "P0"],
  ["Error cases",                          "P0"],
  ["AutoDoc documentation",                "P0"],
  ["Modifier combinations",               "P0"],
  ["Standard library usage",               "P0"],
  ["Preprocessor",                         "P0"],
  ["Enums and constants",                  "P0"],
  ["Cross-file references",                "P1"],
  ["Compatibility",                        "P1"],
  ["Type inference",                       "P1"],
  ["Scoping",                              "P1"],
  ["Rename testing",                       "P1"],
];

function groupByCategory(entries: FileEntry[]): CategorySection[] {
  const map = new Map<string, FileEntry[]>();
  for (const e of entries) {
    if (!map.has(e.category)) map.set(e.category, []);
    map.get(e.category)!.push(e);
  }

  const result: CategorySection[] = [];
  for (const [title, priority] of CATEGORY_ORDER) {
    const list = map.get(title);
    if (list) {
      result.push({
        title,
        priority,
        entries: list.sort((a, b) => a.filename.localeCompare(b.filename)),
      });
      map.delete(title);
    }
  }
  // Leftover categories (from .pmod or unknown prefixes)
  for (const [title, list] of map) {
    const first = list[0];
    result.push({
      title,
      priority: first.priority,
      entries: list.sort((a, b) => a.filename.localeCompare(b.filename)),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Render a single category section
// ---------------------------------------------------------------------------

function renderCategorySection(info: CategorySection, startNum: number): { text: string; endNum: number } {
  const rows: string[] = [];
  rows.push(`### ${info.title}`);
  rows.push("");
  rows.push("| # | File | Feature(s) | Priority | Status |");
  rows.push("|---|------|------------|----------|--------|");

  let num = startNum;
  for (const entry of info.entries) {
    const status = entry.runnerOpts ? "Valid*" : entry.status;
    rows.push(`| ${num} | \`${entry.filename}\` | ${entry.feature} | ${info.priority} | ${status} |`);
    num++;
  }
  rows.push("");

  return { text: rows.join("\n"), endNum: num - 1 };
}

// ---------------------------------------------------------------------------
// Render the full updated manifest.md
// ---------------------------------------------------------------------------

function renderManifest(
  parsed: ParsedManifest,
  onDisk: string[],
  corpusJson: Record<string, RunnerOptions>,
): string {
  const entries = buildEntries(onDisk, parsed, corpusJson);
  const categories = groupByCategory(entries);

  // Find the header section (everything before ## Corpus Files)
  const corpusFilesLineIdx = parsed.lines.findIndex(l => l.startsWith("## Corpus Files"));
  if (corpusFilesLineIdx === -1) throw new Error("Cannot find '## Corpus Files' in manifest.md");

  // Collect the header
  const header = parsed.lines.slice(0, corpusFilesLineIdx);

  // Build category sections text
  const sectionParts: string[] = [];
  let num = 1;
  for (const cat of categories) {
    const { text, endNum } = renderCategorySection(cat, num);
    sectionParts.push(text);
    num = endNum + 1;
  }

  // Build the Planned section
  const plannedSectionIdx = parsed.lines.findIndex(l => l.startsWith("## Planned but Not Yet Created"));
  const summaryLineIdx = parsed.lines.findIndex(l => l.startsWith("## Summary"));
  const plannedSectionOriginal = plannedSectionIdx !== -1
    ? parsed.lines.slice(plannedSectionIdx, summaryLineIdx !== -1 ? summaryLineIdx : parsed.lines.length)
    : null;

  // Files still planned (in manifest planned section but not on disk)
  const onDiskSet = new Set(onDisk);
  const stillPlanned = [...parsed.planned.entries()]
    .filter(([filename]) => !onDiskSet.has(filename))
    .map(([filename, p]) => ({ filename, ...p }));

  // Render the new Planned section
  const plannedLines: string[] = [];
  if (stillPlanned.length > 0 || (plannedSectionOriginal && plannedSectionOriginal.length > 0)) {
    plannedLines.push("");
    plannedLines.push("## Planned but Not Yet Created (P1/P2)");
    plannedLines.push("");
    plannedLines.push("These entries are tracked for future expansion.");
    plannedLines.push("");
    plannedLines.push("| File | Feature(s) | Priority |");
    plannedLines.push("|------|------------|----------|");
    for (const p of stillPlanned) {
      plannedLines.push(`| \`${p.filename}\` | ${p.feature} | ${p.priority} |`);
    }
  }

  // Summary
  const validCount = entries.filter(e => e.status === "Valid" || e.status === "Valid*").length;
  const errorCount = entries.filter(e => e.status === "Error").length;

  const summaryLines: string[] = [];
  summaryLines.push("");
  summaryLines.push("## Summary");
  summaryLines.push("");
  summaryLines.push("| Category | Count | Valid | Error |");
  summaryLines.push("|----------|-------|-------|-------|");

  for (const cat of categories) {
    const v = cat.entries.filter(e => e.status === "Valid" || e.status === "Valid*").length;
    const err = cat.entries.filter(e => e.status === "Error").length;
    summaryLines.push(`| ${cat.title} | ${cat.entries.length} | ${v} | ${err} |`);
  }
  const totalPad = " ".repeat(30 - 7);
  summaryLines.push(`| **Total**${totalPad} | **${entries.length}** | **${validCount}** | **${errorCount}** |`);
  summaryLines.push("");

  const newFilesCount = entries.filter(e => e.isNew).length;
  if (newFilesCount > 0) {
    summaryLines.push(`> **Note:** ${newFilesCount} file(s) on disk not yet committed to the manifest. Run \`bun run scripts/manifest.ts --sync\` to add them.`);
  }

  // Compose final output
  const parts: string[] = [
    ...header,
    `## Corpus Files (${entries.length} committed)`,
    "",
    ...sectionParts,
    ...plannedLines,
    ...summaryLines,
  ];

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const dryRun = process.argv.includes("--dry-run");
const sync = process.argv.includes("--sync");

const onDisk = scanCorpusFiles();
const corpusJson = loadCorpusJson();
const manifestContent = readFileSync(MANIFEST_MD, "utf-8");
const parsed = parseManifestMd(manifestContent);

// Detect discrepancies
const onDiskSet = new Set(onDisk);
const manifestSet = new Set([...parsed.committed.keys(), ...parsed.planned.keys()]);

const missing = onDisk.filter(f => !manifestSet.has(f));
const vanished = [...manifestSet].filter(f => !onDiskSet.has(f));

if (missing.length > 0) {
  console.log(`[WARN] Files on disk not in manifest (${missing.length}):`);
  for (const f of missing) {
    const { category, feature, priority } = classifyFile(f);
    const wasPlanned = parsed.planned.has(f);
    console.log(`  ${f}  → ${category} / ${priority} ${wasPlanned ? "(was planned)" : "(new)"}`);
  }
}

if (vanished.length > 0) {
  console.log(`\n[WARN] Files in manifest but not on disk (${vanished.length}):`);
  for (const f of vanished) {
    const existing = parsed.committed.get(f);
    const planned = parsed.planned.get(f);
    console.log(`  ${f}  → ${existing ? existing.status : "planned:" + planned?.priority}`);
  }
}

if (missing.length === 0 && vanished.length === 0) {
  console.log("Manifest is up to date.");
}

if (sync) {
  const updated = renderManifest(parsed, onDisk, corpusJson);
  writeFileSync(MANIFEST_MD, updated, "utf-8");
  console.log("\nManifest updated.");
} else if (missing.length > 0 || vanished.length > 0) {
  console.log("\nRun `bun run scripts/manifest.ts --sync` to update manifest.md.");
}