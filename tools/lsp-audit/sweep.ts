/**
 * Sweep driver: boots the real server and fires every capability at every
 * meaningful position, writing one ledger record per attempt.
 *
 * The server comes up through createTestServer, the same path lsp-probe uses,
 * so this exercises production code rather than a parallel implementation.
 */

import { basename, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { createTestServer, type TestServer } from "../../tests/lsp/helpers";
import { decodeSource } from "../../server/src/util/sourceDecoder";
import { MATRIX, type CapabilitySpec, type RequestContext } from "./matrix";
import { derivePositions, type SweepPosition } from "./positions";
import { Ledger, type LedgerRecord, type Status, type Surface } from "./ledger";

/**
 * Decides whether a result is the known-correct one.
 *
 * Returns null when no expectation covers this (file, method, position), which
 * is the common case. Injected rather than imported so the sweep stays
 * independent of the expectation set — see Task 6.
 */
export type CorrectnessChecker = (
  file: string,
  method: string,
  position: { line: number; character: number } | null,
  result: unknown,
) => boolean | null;

export interface SweepOptions {
  workspaceRoot: string;
  workspaceName: string;
  surface: Surface;
  files: string[];
  ledger: Ledger;
  timeoutMs?: number;
  slowMs?: number;
  maxRefsPerDecl?: number;
  /** Tier-2 checking. Omitted for the Roxen tier, where answers are unknown. */
  checker?: CorrectnessChecker;
}

interface Outcome {
  status: Status;
  digest: string;
  detail?: string;
  durationMs: number;
}

/** Send one request, bounded by the timeout, and classify what came back. */
async function attempt(
  server: TestServer,
  spec: CapabilitySpec,
  ctx: RequestContext,
  timeoutMs: number,
  checkCorrect?: (result: unknown) => boolean | null,
): Promise<Outcome> {
  const started = performance.now();
  try {
    const result = await withTimeout(
      server.client.sendRequest(spec.method, spec.params(ctx)),
      timeoutMs,
    );
    // A wrong answer outranks an empty one: both are defects, but "answered
    // incorrectly" is the more specific claim, so it wins when both apply.
    const correct = checkCorrect?.(result) ?? null;
    return {
      status: correct === false ? "wrong" : spec.validate(result),
      digest: digestOf(result),
      durationMs: performance.now() - started,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: message === "__audit_timeout__" ? "timeout" : "error",
      digest: "",
      detail: message,
      durationMs: performance.now() - started,
    };
  }
}

/** Exported so the timeout bound can be tested directly — see Task 4's tests. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("__audit_timeout__")), ms),
    ),
  ]);
}

/** A short, comparable summary — enough for triage without storing the result. */
function digestOf(result: unknown): string {
  if (result === null || result === undefined) return "null";
  if (Array.isArray(result)) return `array:${result.length}`;
  const data = (result as { data?: unknown[] }).data;
  if (Array.isArray(data)) return `tokens:${data.length}`;
  const items = (result as { items?: unknown[] }).items;
  if (Array.isArray(items)) return `items:${items.length}`;
  return `object:${Object.keys(result as object).length}`;
}

/** Ask the server for declaration names, tolerating a broken documentSymbol. */
async function symbolNames(server: TestServer, uri: string, timeoutMs: number): Promise<string[]> {
  try {
    const symbols = await withTimeout(
      server.client.sendRequest("textDocument/documentSymbol", { textDocument: { uri } }),
      timeoutMs,
    );
    if (!Array.isArray(symbols)) return [];
    return symbols
      .map((s: { name?: string }) => s.name)
      .filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}

/**
 * Prime the delta cycle: ask for full tokens, then edit the document.
 *
 * A delta request against an unchanged document is not a test of anything —
 * the interesting case is whether the server's patch is right after a real
 * edit. Returns the resultId to send back, or "" if the full request failed.
 */
async function primeDelta(server: TestServer, uri: string, text: string, timeoutMs: number): Promise<string> {
  try {
    const full = await withTimeout(
      server.client.sendRequest("textDocument/semanticTokens/full", { textDocument: { uri } }),
      timeoutMs,
    );
    server.client.sendNotification("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: text + "\nint auditProbeSymbol;\n" }],
    });
    return (full as { resultId?: string } | null)?.resultId ?? "";
  } catch {
    return "";
  }
}

/**
 * Send a lifecycle notification and record that the server survived it.
 *
 * A notification has no reply, so there is nothing to validate. What is being
 * tested is that the server accepts it without throwing — a handler that
 * crashes on didRenameFiles takes the whole session down, which is exactly the
 * kind of defect this audit exists to find.
 */
function notifyAndRecord(
  server: TestServer,
  spec: CapabilitySpec,
  ctx: RequestContext,
  options: SweepOptions,
  relPath: string,
): LedgerRecord {
  const started = performance.now();
  let status: Status = "ok";
  let detail: string | undefined;
  try {
    server.client.sendNotification(spec.method, spec.params(ctx));
  } catch (error) {
    status = "error";
    detail = error instanceof Error ? error.message : String(error);
  }
  return {
    surface: options.surface,
    workspace: options.workspaceName,
    capability: spec.method,
    file: relPath,
    position: null,
    status,
    durationMs: Math.round(performance.now() - started),
    rssBytes: process.memoryUsage().rss,
    digest: "notification",
    detail,
  };
}

/** Sweep one file across the whole matrix. */
async function sweepFile(
  server: TestServer,
  file: string,
  options: SweepOptions,
  write: (record: LedgerRecord) => void,
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  // decodeSource returns a DecodedSource record, not a string — the sniffed
  // encoding rides along with the text. Never substitute a hardcoded utf-8 read.
  const text = decodeSource(readFileSync(file)).text;
  const uri = pathToFileURL(file).href;
  server.openDoc(uri, text, "pike");

  const names = await symbolNames(server, uri, timeoutMs);
  const positions = derivePositions(text, names, options.maxRefsPerDecl ?? 5);
  const relPath = relative(options.workspaceRoot, file) || basename(file);
  const previousResultId = await primeDelta(server, uri, text, timeoutMs);

  for (const spec of MATRIX) {
    // Lifecycle entries are notifications with no response; sendRequest would
    // hang on them until the timeout. They are driven separately, below.
    if (spec.driver === "lifecycle") {
      write(notifyAndRecord(server, spec, { uri, position: null, text }, options, relPath));
      continue;
    }
    const targets: (SweepPosition | null)[] =
      spec.driver === "position" ? positions : [null];
    for (const target of targets) {
      const ctx: RequestContext = {
        uri,
        position: target ? { line: target.line, character: target.character } : null,
        text,
        previousResultId,
      };
      const outcome = await attempt(server, spec, ctx, timeoutMs, (result) =>
        options.checker?.(relPath, spec.method, ctx.position, result) ?? null,
      );
      write({
        surface: options.surface,
        workspace: options.workspaceName,
        capability: spec.method,
        file: relPath,
        position: ctx.position,
        status: outcome.status,
        durationMs: Math.round(outcome.durationMs),
        rssBytes: process.memoryUsage().rss,
        digest: outcome.digest,
        detail: outcome.detail,
      });
    }
  }
}

/** Run the sweep over every file in the workspace. */
export async function runSweep(options: SweepOptions): Promise<void> {
  const server = await createTestServer({
    rootUri: pathToFileURL(options.workspaceRoot).href,
  });

  // Diagnostics are pushed, not requested: the server is push-only by design
  // and advertises no diagnosticProvider. Its absence is not a finding — but a
  // file that never receives a publish notification at all is one, so record
  // what arrives and let triage compare against the files swept.
  server.client.onNotification(
    "textDocument/publishDiagnostics",
    (params: { uri: string; diagnostics: unknown[] }) => {
      options.ledger.append({
        surface: options.surface,
        workspace: options.workspaceName,
        capability: "textDocument/publishDiagnostics",
        file: relative(options.workspaceRoot, new URL(params.uri).pathname),
        position: null,
        status: "ok",
        durationMs: 0,
        rssBytes: process.memoryUsage().rss,
        digest: `array:${params.diagnostics.length}`,
      });
    },
  );

  try {
    for (const file of options.files) {
      await sweepFile(server, file, options, (record) => options.ledger.append(record));
    }
  } finally {
    await server.teardown();
  }
}
