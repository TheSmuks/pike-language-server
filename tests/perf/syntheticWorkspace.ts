/**
 * Synthetic Pike workspace fixture generator.
 *
 * Generates deterministic Pike source files for resource-resilience benchmarks.
 * Each file contains a class with configurable declaration count so tests can
 * measure how the server scales across workspace sizes without depending on
 * external repositories.
 *
 * Used by perf tests (large-workspace.test.ts) to create workspaces of N files
 * with predictable content-hash diversity.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SyntheticFileSpec {
  /** File path relative to workspace root (e.g. "src/Module.pike"). */
  relativePath: string;
  /** Pike source text. */
  content: string;
}

export interface SyntheticWorkspace {
  /** Absolute workspace root. */
  root: string;
  /** File URIs (file:// scheme). */
  uris: string[];
  /** Cleanup — removes the temp directory. */
  cleanup(): void;
}

export interface WorkspaceGeneratorOptions {
  /** Number of Pike files to generate. */
  fileCount: number;
  /** Declarations per file (classes + functions). */
  declarationsPerFile?: number;
  /** Sub-directory depth for nested module trees. */
  maxDepth?: number;
  /** Number of import statements per file (creates dependency edges). */
  importsPerFile?: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_DECLARATIONS_PER_FILE = 5;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_IMPORTS_PER_FILE = 2;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a single synthetic Pike source string.
 */
export function generatePikeSource(
  moduleName: string,
  declarationsPerFile: number,
  imports: string[],
): string {
  const importLines = imports.map(imp => `import ${imp};`).join("\n");
  const decls: string[] = [];

  for (let i = 0; i < declarationsPerFile; i++) {
    const isClass = i % 2 === 0;
    if (isClass) {
      decls.push(`class ${moduleName}_Class${i} {\n  int value${i};\n  string name${i};\n  void set_value(int v) { value${i} = v; }\n}`);
    } else {
      decls.push(`int ${moduleName}_func${i}(int a, int b) {\n  return a + b + ${i};\n}`);
    }
  }

  return `// Auto-generated synthetic Pike file for ${moduleName}\n${importLines}\n\n${decls.join("\n\n")}\n`;
}

/**
 * Generate file specs for a synthetic workspace.
 */
export function generateFileSpecs(options: WorkspaceGeneratorOptions): SyntheticFileSpec[] {
  const {
    fileCount,
    declarationsPerFile = DEFAULT_DECLARATIONS_PER_FILE,
    maxDepth = DEFAULT_MAX_DEPTH,
    importsPerFile = DEFAULT_IMPORTS_PER_FILE,
  } = options;

  const specs: SyntheticFileSpec[] = [];
  const moduleNames: string[] = [];

  for (let f = 0; f < fileCount; f++) {
    const depth = f % (maxDepth + 1);
    const dirParts: string[] = [];
    for (let d = 0; d < depth; d++) {
      dirParts.push(`dir${(f + d) % 10}`);
    }
    const moduleName = `Mod${f}`;
    moduleNames.push(moduleName);
    const relativePath = join(...dirParts, `${moduleName}.pike`);

    const imports: string[] = [];
    for (let imp = 0; imp < importsPerFile; imp++) {
      const targetIdx = (f + imp + 1) % fileCount;
      imports.push(`.(dir${targetIdx % 10}.${moduleNames[targetIdx] ?? "Std"})`);
    }

    specs.push({
      relativePath,
      content: generatePikeSource(moduleName, declarationsPerFile, imports),
    });
  }

  return specs;
}

/**
 * Create a synthetic workspace on disk in a temp directory.
 * Returns the workspace root, file URIs, and a cleanup function.
 */
export function createSyntheticWorkspace(options: WorkspaceGeneratorOptions): SyntheticWorkspace {
  const root = mkdtempSync(join(tmpdir(), "pike-lsp-synth-"));
  const specs = generateFileSpecs(options);
  const uris: string[] = [];

  for (const spec of specs) {
    const fullPath = join(root, spec.relativePath);
    const dir = join(fullPath, "..");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, spec.content, "utf-8");
    uris.push(`file://${fullPath}`);
  }

  return {
    root,
    uris,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
