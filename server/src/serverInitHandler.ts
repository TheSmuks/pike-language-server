/**
 * onInitialize handler — wires initialization options to server state.
 *
 * Extracted from server.ts to keep createPikeServer under the 50-line
 * TigerStyle function limit.
 */

import { readFile } from "node:fs/promises";
import type { Connection } from "vscode-languageserver/node";
import type { InitializeParams } from "vscode-languageserver/node";
import { buildServerCapabilities } from "./serverCapabilities";
import { uriToPath } from "./util/uri";
import { parse } from "./parser";
import { WorkspaceIndex, ModificationSource } from "./features/workspaceIndex";
import { logInfo, logWarn } from "./util/errorLog.js";
import type { ServerContext } from "./serverContext";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InitOptions {
  diagnosticMode?: string;
  pikeBinaryPath?: string;
  diagnosticDebounceMs?: number;
  maxNumberOfProblems?: number;
  backgroundIndexEnabled?: boolean;
  backgroundIndexBatchSize?: number;
  workerRequestTimeoutMs?: number;
  workerIdleTimeoutMs?: number;
  workerMaxRequestsBeforeRestart?: number;
  workerMaxActiveMinutes?: number;
  workerNiceValue?: number;
  formatInsertFinalNewline?: boolean;
  formatOperatorSpacing?: boolean;
  // Path overrides — when set, bypass auto-detection
  pikeHome?: string;
  modulePaths?: string[];
  includePaths?: string[];
  programPaths?: string[];
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Register the onInitialize handler on the connection. */
export function registerInitHandler(
  connection: Connection,
  ctx: ServerContext,
): void {
  // onInitialize expects a sync return or Promise — wrap the async work.
  connection.onInitialize(async (params: InitializeParams) => {
    return handleInitialize(ctx, params);
  });
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

async function handleInitialize(
  ctx: ServerContext,
  params: InitializeParams,
) {
  logInfo(ctx.connection, "[init] step 6: onInitialize — client connected");

  const rootUri = params.rootUri ?? params.rootPath ?? "";
  const rootPath = uriToPath(rootUri);
  ctx.clientSupportsWatchedFiles =
    params.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;

  logInfo(ctx.connection, `[init] step 6a: workspace root = ${rootPath || "(none)"}`);

  const initOpts = params.initializationOptions as InitOptions | undefined;

  await applyWorkspaceIndex(ctx, rootPath, initOpts);
  applyDiagnosticOptions(ctx, initOpts);
  applyWorkerOptions(ctx, initOpts);
  applyBackgroundIndexOptions(ctx, initOpts);
  applyFormattingOptions(ctx, initOpts);

  return buildServerCapabilities();
}

// ---------------------------------------------------------------------------
// Sub-steps
// ---------------------------------------------------------------------------

async function applyWorkspaceIndex(
  ctx: ServerContext,
  rootPath: string,
  initOpts?: InitOptions,
): Promise<void> {
  const pikeBinaryPath = initOpts?.pikeBinaryPath;
  logInfo(ctx.connection, `[init] step 6b: creating workspace index (pikeBinaryPath=${pikeBinaryPath ?? "pike"})`);

  // Build path overrides from settings. Only include non-empty values.
  const overrides: import("./features/pikeDetection").PikePathOverrides = {};
  if (initOpts?.pikeHome) overrides.pikeHome = initOpts.pikeHome;
  if (initOpts?.modulePaths && initOpts.modulePaths.length > 0) overrides.modulePaths = initOpts.modulePaths;
  if (initOpts?.includePaths && initOpts.includePaths.length > 0) overrides.includePaths = initOpts.includePaths;
  if (initOpts?.programPaths && initOpts.programPaths.length > 0) overrides.programPaths = initOpts.programPaths;

  const hasOverrides = overrides.pikeHome || overrides.modulePaths || overrides.includePaths || overrides.programPaths;
  if (hasOverrides) {
    logInfo(ctx.connection, `[init] step 6b: path overrides provided — ${JSON.stringify(overrides)}`);
  }

  const newIndex = await WorkspaceIndex.create(rootPath, pikeBinaryPath, hasOverrides ? overrides : undefined);
  ctx.index = newIndex;
  ctx.diagnosticManager.setIndex(newIndex);

  newIndex.setOnDemandIndexFn(async (targetUri: string) => {
    return onDemandIndex(ctx, targetUri);
  });

  logInfo(ctx.connection, "[init] step 6b: workspace index created");
}

async function onDemandIndex(
  ctx: ServerContext,
  targetUri: string,
): Promise<import("./features/workspaceTypes").FileEntry | null> {
  try {
    const filePath = uriToPath(targetUri);
    const content = await readFile(filePath, "utf-8");
    const tree = parse(content, targetUri);
    return await ctx.index.upsertFile(
      targetUri, 0, tree, content, ModificationSource.BackgroundIndex,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "ENOENT") {
      logWarn(ctx.connection, `on-demand index: skipping ${targetUri}: ${code}`);
    }
    return null;
  }
}

function applyDiagnosticOptions(
  ctx: ServerContext,
  initOpts?: InitOptions,
): void {
  if (!initOpts) return;
  const mode = initOpts.diagnosticMode;
  if (mode === "realtime" || mode === "saveOnly" || mode === "off") {
    ctx.diagnosticManager.setDiagnosticMode(mode);
  }
  if (initOpts.diagnosticDebounceMs && initOpts.diagnosticDebounceMs > 0) {
    ctx.diagnosticManager.setDebounceMs(initOpts.diagnosticDebounceMs);
  }
  if (initOpts.maxNumberOfProblems && initOpts.maxNumberOfProblems > 0) {
    ctx.diagnosticManager.setMaxNumberOfProblems(initOpts.maxNumberOfProblems);
  }
}

function applyWorkerOptions(
  ctx: ServerContext,
  initOpts?: InitOptions,
): void {
  if (!initOpts) return;
  if (initOpts.pikeBinaryPath) {
    ctx.worker.updateConfig({ pikeBinaryPath: initOpts.pikeBinaryPath });
  }
  if (initOpts.workerRequestTimeoutMs != null && initOpts.workerRequestTimeoutMs > 0) {
    ctx.worker.updateConfig({ requestTimeoutMs: initOpts.workerRequestTimeoutMs });
  }
  if (initOpts.workerIdleTimeoutMs != null && initOpts.workerIdleTimeoutMs >= 0) {
    ctx.worker.updateConfig({ idleTimeoutMs: initOpts.workerIdleTimeoutMs });
  }
  if (initOpts.workerMaxRequestsBeforeRestart != null && initOpts.workerMaxRequestsBeforeRestart >= 0) {
    ctx.worker.updateConfig({ maxRequestsBeforeRestart: initOpts.workerMaxRequestsBeforeRestart });
  }
  if (initOpts.workerMaxActiveMinutes != null && initOpts.workerMaxActiveMinutes >= 0) {
    ctx.worker.updateConfig({ maxActiveMinutes: initOpts.workerMaxActiveMinutes });
  }
  if (initOpts.workerNiceValue != null && initOpts.workerNiceValue >= 0) {
    ctx.worker.updateConfig({ niceValue: initOpts.workerNiceValue });
  }
}

function applyBackgroundIndexOptions(
  ctx: ServerContext,
  initOpts?: InitOptions,
): void {
  if (!initOpts) return;
  if (initOpts.backgroundIndexEnabled != null) {
    ctx.backgroundIndexEnabled = initOpts.backgroundIndexEnabled;
  }
  if (initOpts.backgroundIndexBatchSize != null && initOpts.backgroundIndexBatchSize > 0) {
    ctx.backgroundIndexBatchSize = initOpts.backgroundIndexBatchSize;
  }
}

function applyFormattingOptions(
  ctx: ServerContext,
  initOpts?: InitOptions,
): void {
  if (!initOpts) return;
  if (initOpts.formatInsertFinalNewline != null) {
    ctx.formattingConfig.insertFinalNewline = initOpts.formatInsertFinalNewline;
  }
  if (initOpts.formatOperatorSpacing != null) {
    ctx.formattingConfig.operatorSpacing = initOpts.formatOperatorSpacing;
  }
}
