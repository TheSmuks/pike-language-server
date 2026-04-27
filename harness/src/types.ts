/**
 * Types for the Pike introspection harness.
 * Mirrors the JSON schema produced by harness/introspect.pike.
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

export interface IntrospectionResult {
  file: string;
  pike_version: string;
  compilation: CompilationResult;
  diagnostics: Diagnostic[];
  autodoc: string | null;
  error: string | null;
}

export interface SnapshotDiff {
  field: string;
  expected: unknown;
  actual: unknown;
}
