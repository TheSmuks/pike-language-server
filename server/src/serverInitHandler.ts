/**
 * onInitialize handler — wires initialization options to server state.
 *
 * Extracted from server.ts to keep createPikeServer under the 50-line
 * TigerStyle function limit.
 */

import type { Connection } from "vscode-languageserver/node";
import type { InitializeParams } from "vscode-languageserver/node";
import { ResponseError, ErrorCodes } from "vscode-languageserver/node";
import { buildServerCapabilities } from "./serverCapabilities";
import { uriToPath } from "./util/uri";
import { parse } from "./parser";
import { WorkspaceIndex, ModificationSource } from "./features/workspaceIndex";
import { hydrateFromCache } from "./features/cacheHydrate";
import { logInfo, logWarn, logError, ErrorCategory, setLogPathRedactionEnabled, logUnsupportedCharset } from "./util/errorLog.js";
import { readSource } from "./util/sourceDecoder.js";
import { getPikePaths } from "./features/pikeDetection.js";
import type { PikePathOverrides } from "./features/pikeDetection.js";
import type { ServerContext } from "./serverContext";
import { parseResourceConfig, type RawResourceSettings } from "./features/resourceConfiguration";
import { getRoxenPaths } from "./features/roxenDetection.js";
import { DEFAULT_ROXEN_MODE, isRoxenMode, type RoxenMode } from "./features/roxenActivation.js";
import type { ResourceConfiguration } from "./features/resourceTypes";
import { SERVER_VERSION } from "./version.js";

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
  workerLdLibraryPath?: string;
  formatInsertFinalNewline?: boolean;
  formatOperatorSpacing?: boolean;
  debugTelemetry?: boolean;
  logPathRedactionEnabled?: boolean;
  // Path overrides — when set, bypass auto-detection
  pikeHome?: string;
  modulePaths?: string[];
  includePaths?: string[];
  programPaths?: string[];
  // Roxen support
  roxenMode?: string;
  roxenPath?: string;
  // Resource-resilience settings
  indexingMode?: string;
  indexIgnoreGlobs?: string[];
  indexMaxFileSizeBytes?: number;
  indexDependencyClosureDepth?: number;
  indexDependencyClosureCount?: number;
  memoryBudgetMb?: number;
  workerHeartbeatIntervalMs?: number;
  workerWatchdogTimeoutMs?: number;
  workerIdleEvictionMs?: number;
  workerHealthCheckIntervalMs?: number;
  workerMaxConsecutiveFailures?: number;
  workerBackoffInitialMs?: number;
  workerBackoffMaxMs?: number;
  hibernationIdleThresholdMs?: number;
  hibernationSustainedActivityMs?: number;
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
  // LSP: the client sends `initialize` exactly once. A second one used to
  // re-run the whole sequence — rebuilding the index, respawning the worker —
  // against a server already serving requests.
  if (ctx.lifecycleState !== "uninitialized") {
    throw new ResponseError(
      ErrorCodes.InvalidRequest,
      "Server is already initialized",
    );
  }
  logInfo(ctx.connection, "[init] step 6: onInitialize — client connected");

  const rootUri = params.rootUri ?? params.rootPath ?? "";
  const rootPath = uriToPath(rootUri);
  ctx.clientSupportsWatchedFiles =
    params.capabilities?.workspace?.didChangeWatchedFiles?.dynamicRegistration === true;
  ctx.clientSupportsSemanticTokensRefresh =
    params.capabilities?.workspace?.semanticTokens?.refreshSupport === true;

  const initOpts = params.initializationOptions as InitOptions | undefined;
  applyLogOptions(initOpts);

  logInfo(ctx.connection, `[init] step 6a: workspace root = ${rootPath || "(none)"}`);

  await applyWorkspaceIndex(ctx, rootPath, initOpts);
  applyDiagnosticOptions(ctx, initOpts);
  await applyWorkerOptions(ctx, rootPath, initOpts);
  applyBackgroundIndexOptions(ctx, initOpts);
  applyFormattingOptions(ctx, initOpts);
  applyDebugOptions(ctx, initOpts);
  applyResourceConfig(ctx, initOpts);

  // Only now: a failure above must not leave the server claiming to be running.
  ctx.lifecycleState = "running";

  return {
    ...buildServerCapabilities(),
    serverInfo: { name: "pike-language-server", version: SERVER_VERSION },
  };
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

  const roxenMode = isRoxenMode(initOpts?.roxenMode) ? initOpts.roxenMode : DEFAULT_ROXEN_MODE;
  ctx.roxenMode = roxenMode;

  const newIndex = await WorkspaceIndex.create(
    rootPath,
    pikeBinaryPath,
    hasOverrides ? overrides : undefined,
    { mode: roxenMode, ...(initOpts?.roxenPath ? { explicitPath: initOpts.roxenPath } : {}) },
  );
  ctx.index = newIndex;
  ctx.diagnosticManager.setIndex(newIndex);
  await logRoxenDetection(ctx, rootPath, roxenMode, initOpts?.roxenPath);

  newIndex.setOnDemandIndexFn(async (targetUri: string) => {
    return onDemandIndex(ctx, targetUri);
  });

  logInfo(ctx.connection, "[init] step 6b: workspace index created");
}

/**
 * Report what Roxen detection found.
 *
 * A misconfigured path is reported at warning level rather than swallowed:
 * detection deliberately falls through to the next source so a stale setting
 * degrades instead of disabling the feature, which means the user would
 * otherwise get working-but-not-what-they-asked-for with no explanation.
 * Absence is ordinary and logged at info level.
 */
async function logRoxenDetection(
  ctx: ServerContext,
  rootPath: string,
  mode: RoxenMode,
  explicitPath?: string,
): Promise<void> {
  if (mode === "off") {
    logInfo(ctx.connection, "[init] roxen: disabled by pike.roxen.mode=off");
    return;
  }

  const detection = await getRoxenPaths(rootPath, explicitPath ? { explicitPath } : undefined);
  if (detection.misconfiguredPath) {
    logWarn(
      ctx.connection,
      `[init] roxen: configured path holds no Roxen installation: ${detection.misconfiguredPath}`,
    );
  }
  if (detection.paths) {
    logInfo(
      ctx.connection,
      `[init] roxen: ${detection.paths.roxenHome} (version ${detection.paths.version}, found via ${detection.source})`,
    );
  } else {
    logInfo(ctx.connection, "[init] roxen: no installation detected — using the bundled index");
  }
}

async function onDemandIndex(
  ctx: ServerContext,
  targetUri: string,
): Promise<import("./features/workspaceTypes").FileEntry | null> {
  try {
    const filePath = uriToPath(targetUri);
    const content = await readSource(filePath, (declared) =>
      logUnsupportedCharset(ctx.connection, `onDemandIndex(${filePath})`, declared),
    );
    // Fast path: hydrate a stub from cache when the source is unchanged.
    if (await hydrateFromCache(ctx.index, ctx.index.workspaceRoot, targetUri, content)) {
      return ctx.index.getFile(targetUri) ?? null;
    }
    const tree = parse(content, targetUri);
    return await ctx.index.upsertFile(
      targetUri, 0, tree, content, ModificationSource.BackgroundIndex,
    );
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM" || code === "ENOENT") {
      logWarn(ctx.connection, `on-demand index: skipping ${targetUri}: ${code}`);
    } else {
      logError(ctx.connection, ErrorCategory.Index, `on-demand index: ${targetUri}`, err);
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

async function applyWorkerOptions(
  ctx: ServerContext,
  rootPath: string,
  initOpts?: InitOptions,
): Promise<void> {
  // Build path overrides from settings (same logic as applyWorkspaceIndex).
  const overrides: PikePathOverrides = {};
  if (initOpts?.pikeHome) overrides.pikeHome = initOpts.pikeHome;
  if (initOpts?.modulePaths && initOpts.modulePaths.length > 0) overrides.modulePaths = initOpts.modulePaths;
  if (initOpts?.includePaths && initOpts.includePaths.length > 0) overrides.includePaths = initOpts.includePaths;
  if (initOpts?.programPaths && initOpts.programPaths.length > 0) overrides.programPaths = initOpts.programPaths;

  const pikePaths = await getPikePaths(rootPath, initOpts?.pikeBinaryPath, overrides);
  const autoLdLibraryPath = pikePaths.ldLibraryPath;

  // Apply explicit user setting if provided; otherwise fall back to auto-detected path.
  if (initOpts?.workerLdLibraryPath != null && initOpts.workerLdLibraryPath !== "") {
    ctx.worker.updateConfig({ libraryPath: initOpts.workerLdLibraryPath });
  } else if (autoLdLibraryPath !== "") {
    ctx.worker.updateConfig({ libraryPath: autoLdLibraryPath });
  }

  if (initOpts?.pikeBinaryPath) {
    ctx.worker.updateConfig({ pikeBinaryPath: initOpts.pikeBinaryPath });
  }
  if (initOpts?.workerRequestTimeoutMs != null && initOpts.workerRequestTimeoutMs > 0) {
    ctx.worker.updateConfig({ requestTimeoutMs: initOpts.workerRequestTimeoutMs });
  }
  if (initOpts?.workerIdleTimeoutMs != null && initOpts.workerIdleTimeoutMs >= 0) {
    ctx.worker.updateConfig({ idleTimeoutMs: initOpts.workerIdleTimeoutMs });
  }
  if (initOpts?.workerMaxRequestsBeforeRestart != null && initOpts.workerMaxRequestsBeforeRestart >= 0) {
    ctx.worker.updateConfig({ maxRequestsBeforeRestart: initOpts.workerMaxRequestsBeforeRestart });
  }
  if (initOpts?.workerMaxActiveMinutes != null && initOpts.workerMaxActiveMinutes >= 0) {
    ctx.worker.updateConfig({ maxActiveMinutes: initOpts.workerMaxActiveMinutes });
  }
  if (initOpts?.workerNiceValue != null && initOpts.workerNiceValue >= 0) {
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

function applyDebugOptions(
  ctx: ServerContext,
  initOpts?: InitOptions,
): void {
  if (!initOpts) return;
  if (typeof initOpts.debugTelemetry === "boolean") {
    ctx.debugTelemetry = initOpts.debugTelemetry;
    ctx.diagnosticManager.setDebugTelemetry(initOpts.debugTelemetry);
  }
}

function applyLogOptions(initOpts?: InitOptions): void {
  if (!initOpts) return;
  if (typeof initOpts.logPathRedactionEnabled === "boolean") {
    setLogPathRedactionEnabled(initOpts.logPathRedactionEnabled);
  }
}

function applyResourceConfig(ctx: ServerContext, initOpts?: InitOptions): void {
  if (!initOpts) return;
  const raw: RawResourceSettings = {
    indexingMode: initOpts.indexingMode,
    indexIgnoreGlobs: initOpts.indexIgnoreGlobs,
    indexMaxFileSizeBytes: initOpts.indexMaxFileSizeBytes,
    indexDependencyClosureDepth: initOpts.indexDependencyClosureDepth,
    indexDependencyClosureCount: initOpts.indexDependencyClosureCount,
    memoryBudgetMb: initOpts.memoryBudgetMb,
    workerRequestTimeoutMs: initOpts.workerRequestTimeoutMs,
    workerHeartbeatIntervalMs: initOpts.workerHeartbeatIntervalMs,
    workerWatchdogTimeoutMs: initOpts.workerWatchdogTimeoutMs,
    workerIdleEvictionMs: initOpts.workerIdleEvictionMs,
    workerHealthCheckIntervalMs: initOpts.workerHealthCheckIntervalMs,
    workerMaxConsecutiveFailures: initOpts.workerMaxConsecutiveFailures,
    workerBackoffInitialMs: initOpts.workerBackoffInitialMs,
    workerBackoffMaxMs: initOpts.workerBackoffMaxMs,
    hibernationIdleThresholdMs: initOpts.hibernationIdleThresholdMs,
    hibernationSustainedActivityMs: initOpts.hibernationSustainedActivityMs,
  };
  ctx.resourceConfig = parseResourceConfig(raw);
  logInfo(ctx.connection, `[init] resource config: mode=${ctx.resourceConfig.indexing.mode} budget=${ctx.resourceConfig.memory.budgetMb}MB`);
}

/**
 * T036: Check if current heap usage exceeds the memory budget.
 *
 * Returns true if the server should enter degraded mode to avoid OOM.
 * Compares process.memoryUsage().heapUsed against the configured budget.
 */
export function isOverMemoryBudget(
  resourceConfig: ResourceConfiguration,
  connection: Connection,
): boolean {
  const budgetBytes = resourceConfig.memory.budgetMb * 1024 * 1024;
  const heapUsed = process.memoryUsage().heapUsed;

  if (heapUsed > budgetBytes) {
    logWarn(
      connection,
      `[init] memory budget exceeded: heapUsed=${Math.round(heapUsed / 1024 / 1024)}MB > budget=${resourceConfig.memory.budgetMb}MB — entering degraded mode`,
    );
    return true;
  }

  return false;
}
