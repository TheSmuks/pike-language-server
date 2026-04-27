/**
 * Types for the Pike introspection harness.
 * Mirrors the JSON schema produced by harness/introspect.pike.
 *
 * IntrospectionResult is intentionally extensible — Phase 3+ will add
 * `symbols`, `types`, and other fields. The snapshot canonicalizer
 * and diff logic are generic and handle any top-level field.
 */

export interface Diagnostic {
  line: number;
  severity: "error" | "warning";
  message: string;
  category: string;
  expected_type?: string;
  actual_type?: string;
}

export interface CompilationResult {
  exit_code: number;
  strict_types: boolean;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  line?: number;
}

/**
 * Core fields from the Pike introspection script.
 * Additional fields may be added by future phases (symbols, types, etc.)
 * and will be handled by the generic snapshot infrastructure.
 */
export interface IntrospectionResult {
  file: string;
  pike_version: string;
  compilation: CompilationResult;
  diagnostics: Diagnostic[];
  autodoc: string | null;
  error: string | null;
  symbols: SymbolInfo[];
}

export interface SnapshotDiff {
  field: string;
  expected: unknown;
  actual: unknown;
}
