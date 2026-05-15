/**
 * Runtime JSON validators for Pike subprocess responses.
 *
 * Every response from the Pike worker is `JSON.parse`'d into `unknown`.
 * These guard functions validate the shape at runtime and return a typed
 * object — replacing bare `as unknown as T` casts with fail-fast checks
 * that surface malformed data as explicit errors.
 *
 * TigerStyle: safety-first, explicit error handling, no hidden state.
 */

import type {
  DiagnoseResult,
  AutodocResult,
  TypeofResult,
  ResolveResult,
  PikeDiagnostic,
} from "../features/pikeWorker.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Assert that `value` is a plain object (not null, not array). */
function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Validation failed: ${label} — expected object, got ${typeof value}`);
  }
}

/** Assert that `value` is a string. */
function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`Validation failed: ${label} — expected string, got ${typeof value}`);
  }
}

/** Assert that `value` is a number (finite, not NaN). */
function assertNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Validation failed: ${label} — expected number, got ${typeof value}`);
  }
}

/** Assert that `value` is a boolean. */
function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Validation failed: ${label} — expected boolean, got ${typeof value}`);
  }
}

/** Check if value is a plain object (non-asserting, for conditionals). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// PikeResponse envelope
// ---------------------------------------------------------------------------

export interface PikeResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * Validate a raw JSON-parse result as a PikeResponse envelope.
 * Returns the typed PikeResponse or throws on malformed data.
 */
export function validatePikeResponse(raw: unknown): PikeResponse {
  assertObject(raw, "PikeResponse");

  // Required: id (number)
  assertNumber(raw["id"], "PikeResponse.id");

  // Optional: error — must be { code: number, message: string } if present
  if ("error" in raw && raw.error !== undefined) {
    assertObject(raw["error"], "PikeResponse.error");
    assertNumber(raw["error"]["code"], "PikeResponse.error.code");
    assertString(raw["error"]["message"], "PikeResponse.error.message");
  }

  // Optional: result — must be an object if present
  if ("result" in raw && raw.result !== undefined) {
    assertObject(raw["result"], "PikeResponse.result");
  }

  return raw as unknown as PikeResponse;
}

// ---------------------------------------------------------------------------
// Per-method result validators
// ---------------------------------------------------------------------------

/**
 * Validate a PikeDiagnostic array element.
 */
function validatePikeDiagnostic(raw: unknown, index: number): PikeDiagnostic {
  assertObject(raw, `PikeDiagnostic[${index}]`);
  assertNumber(raw["line"], `PikeDiagnostic[${index}].line`);
  assertString(raw["severity"], `PikeDiagnostic[${index}].severity`);

  // severity must be "error" or "warning"
  if (raw["severity"] !== "error" && raw["severity"] !== "warning") {
    throw new Error(
      `Validation failed: PikeDiagnostic[${index}].severity — expected "error"|"warning", got "${raw["severity"]}"`,
    );
  }

  assertString(raw["message"], `PikeDiagnostic[${index}].message`);

  // Optional fields
  if ("expected_type" in raw && raw["expected_type"] !== undefined) {
    assertString(raw["expected_type"], `PikeDiagnostic[${index}].expected_type`);
  }
  if ("actual_type" in raw && raw["actual_type"] !== undefined) {
    assertString(raw["actual_type"], `PikeDiagnostic[${index}].actual_type`);
  }
  if ("code" in raw && raw["code"] !== undefined) {
    assertString(raw["code"], `PikeDiagnostic[${index}].code`);
  }

  return raw as unknown as PikeDiagnostic;
}

/**
 * Validate a diagnose method result.
 */
export function validateDiagnoseResult(raw: unknown): DiagnoseResult {
  assertObject(raw, "DiagnoseResult");

  // Required: diagnostics (array)
  const diagnostics = raw["diagnostics"];
  if (!Array.isArray(diagnostics)) {
    throw new Error(`Validation failed: DiagnoseResult.diagnostics — expected array, got ${typeof diagnostics}`);
  }

  // Validate each diagnostic
  for (let i = 0; i < diagnostics.length; i++) {
    validatePikeDiagnostic(diagnostics[i], i);
  }

  // Required: exit_code (number)
  assertNumber(raw["exit_code"], "DiagnoseResult.exit_code");

  // Optional: timedOut
  if ("timedOut" in raw && raw["timedOut"] !== undefined) {
    assertBoolean(raw["timedOut"], "DiagnoseResult.timedOut");
  }

  return raw as unknown as DiagnoseResult;
}

/**
 * Validate an autodoc method result.
 */
export function validateAutodocResult(raw: unknown): AutodocResult {
  assertObject(raw, "AutodocResult");
  assertString(raw["xml"], "AutodocResult.xml");

  // Optional: error
  if ("error" in raw && raw["error"] !== undefined) {
    assertString(raw["error"], "AutodocResult.error");
  }

  return raw as unknown as AutodocResult;
}

/**
 * Validate a typeof method result.
 */
export function validateTypeofResult(raw: unknown): TypeofResult {
  assertObject(raw, "TypeofResult");
  assertString(raw["type"], "TypeofResult.type");

  // Optional: error
  if ("error" in raw && raw["error"] !== undefined) {
    assertString(raw["error"], "TypeofResult.error");
  }

  return raw as unknown as TypeofResult;
}

/**
 * Validate a resolve method result.
 */
export function validateResolveResult(raw: unknown): ResolveResult {
  assertObject(raw, "ResolveResult");

  // Required: resolved (boolean)
  assertBoolean(raw["resolved"], "ResolveResult.resolved");

  // Optional string fields
  const optionalStrings = ["name", "kind", "source_file", "error"] as const;
  for (const field of optionalStrings) {
    if (field in raw && raw[field] !== undefined) {
      assertString(raw[field], `ResolveResult.${field}`);
    }
  }

  // Optional: source_line (number)
  if ("source_line" in raw && raw["source_line"] !== undefined) {
    assertNumber(raw["source_line"], "ResolveResult.source_line");
  }

  // Optional array fields with typed elements
  const arrayFields = [
    "methods",
    "constants",
    "inherits",
  ] as const;

  for (const field of arrayFields) {
    if (field in raw && raw[field] !== undefined) {
      const arr = raw[field];
      if (!Array.isArray(arr)) {
        throw new Error(`Validation failed: ResolveResult.${field} — expected array, got ${typeof arr}`);
      }
      for (let i = 0; i < arr.length; i++) {
        assertObject(arr[i], `ResolveResult.${field}[${i}]`);
        assertString(arr[i]["name"], `ResolveResult.${field}[${i}].name`);
        if ("source_file" in arr[i] && arr[i]["source_file"] !== undefined) {
          assertString(arr[i]["source_file"], `ResolveResult.${field}[${i}].source_file`);
        }
        if ("source_line" in arr[i] && arr[i]["source_line"] !== undefined) {
          assertNumber(arr[i]["source_line"], `ResolveResult.${field}[${i}].source_line`);
        }
      }
    }
  }

  // Optional string array fields
  const stringArrayFields = [
    "inherited_methods",
    "inherited_constants",
  ] as const;

  for (const field of stringArrayFields) {
    if (field in raw && raw[field] !== undefined) {
      const arr = raw[field];
      if (!Array.isArray(arr)) {
        throw new Error(`Validation failed: ResolveResult.${field} — expected array, got ${typeof arr}`);
      }
      for (let i = 0; i < arr.length; i++) {
        assertString(arr[i], `ResolveResult.${field}[${i}]`);
      }
    }
  }

  return raw as unknown as ResolveResult;
}

/**
 * Validate a ping method result.
 */
export function validatePingResult(raw: unknown): { status: string; pike_version: string } {
  assertObject(raw, "PingResult");
  assertString(raw["status"], "PingResult.status");
  assertString(raw["pike_version"], "PingResult.pike_version");

  return raw as { status: string; pike_version: string };
}
