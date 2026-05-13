/**
 * Pike Language Server — VSCode extension entry point.
 *
 * Starts the LSP server as a child process communicating over stdio.
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";
import {
  type StateChangeEvent,
  type ErrorHandler,
  type ErrorHandlerResult,
  type CloseHandlerResult,
  ErrorAction,
  CloseAction,
  State,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
  Trace,
} from "vscode-languageclient/node";

import { TreeSitterSyntacticProvider } from "./treeSitterProvider";
import {
  setErrorCount,
  getErrorCount,
  onErrorCountChange,
} from "./errorNotificationState";

let client: LanguageClient | undefined;

// ─── Observability ──────────────────────────────────────────────────────────

/**
 * Log output channel with native VSCode coloring.
 * Using `{ log: true }` creates a LogOutputChannel which renders
 * [INFO] [WARN] [ERROR] [DEBUG] level tags in their respective colors.
 * VSCode adds its own timestamp, so we only provide the label + message.
 */
const outputChannel = vscode.window.createOutputChannel("Pike Language Server", { log: true });
/** Status bar item reflecting server state. */
const statusBarItem = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Right,
  /* priority */ 99,
);

/** Log level matching VSCode LogOutputChannel methods. */
type LogLevel = "info" | "warn" | "error" | "debug";

/**
 * Log a message to the output channel with a colored level tag.
 * VSCode's LogOutputChannel adds the timestamp and renders [INFO]/[WARN]/etc.
 * in their native colors (blue, yellow, red, gray).
 */
function log(level: LogLevel, label: string, message: string): void {
  const formatted = `[${label}] ${message}`;
  switch (level) {
    case "debug": outputChannel.debug(formatted); break;
    case "info":  outputChannel.info(formatted); break;
    case "warn":  outputChannel.warn(formatted); break;
    case "error": outputChannel.error(formatted); break;
  }
}

/** Update the status bar to reflect server state and optional error count. */
function updateStatusBar(state: State, errorCount = 0): void {
  const errorSuffix = errorCount > 0 ? ` (${errorCount} error${errorCount === 1 ? "" : "s"})` : "";
  switch (state) {
    case State.Starting: {
      statusBarItem.text = `$(sync~spin) Pike LSP${errorSuffix}`;
      statusBarItem.backgroundColor = undefined;
      statusBarItem.color = undefined;
      break;
    }
    case State.Running: {
      if (errorCount > 0) {
        statusBarItem.text = `$(error) Pike LSP${errorSuffix}`;
        statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        statusBarItem.color = new vscode.ThemeColor("statusBarItem.errorForeground");
      } else {
        statusBarItem.text = `$(zap) Pike LSP`;
        statusBarItem.backgroundColor = undefined;
        statusBarItem.color = undefined;
      }
      break;
    }
    case State.Stopped: {
      statusBarItem.text = `$(warning) Pike LSP${errorSuffix}`;
      statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      statusBarItem.color = new vscode.ThemeColor("statusBarItem.errorForeground");
      break;
    }
    default: {
      statusBarItem.text = `$(question) Pike LSP${errorSuffix}`;
      break;
    }
  }
}

/** Map the `pike.languageServer.trace.server` value to a vscode-languageclient Trace. */
function applyTraceSetting(langClient: LanguageClient): void {
  const raw = vscode.workspace.getConfiguration("pike.languageServer").get<string>("trace.server", "off");
  const trace = raw === "verbose" ? Trace.Verbose
    : raw === "messages" ? Trace.Messages
    : Trace.Off;
  langClient.setTrace(trace);
}

/** Convenience wrapper for updating status bar with error count. */
function updateStatusBarWithErrors(state: State, errorCount: number): void {
  updateStatusBar(state, errorCount);
}

/**
 * Custom error handler that logs to the output channel instead of
 * showing transient popup errors for every server hiccup.
 */
function makeErrorHandler(label: string): ErrorHandler {
  return {
    error(_error: Error, message: unknown): ErrorHandlerResult {
      // message is the LSP Message (or derived type) in-flight when the error occurred.
      // Narrow safely — only Request/Notification types carry a `method` field.
      const method =
        typeof message === "object" && message !== null && "method" in message
          ? (message as { method: string }).method
          : "unknown";
      log("error", label, `Server error during ${method}`);
      return { action: ErrorAction.Continue };
    },

    closed(): CloseHandlerResult {
      log("warn", label, "Server process exited");
      return { action: CloseAction.DoNotRestart };
    },
  };
}

// ─── Settings ────────────────────────────────────────────────────────────────

/**
 * Read language server settings from VSCode configuration.
 */
function getSettings(): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration("pike.languageServer");
  return {
    pikeBinaryPath: config.get<string>("path", "pike"),
    diagnosticMode: config.get<string>("diagnosticMode", "realtime"),
    diagnosticDebounceMs: config.get<number>("diagnosticDebounceMs", 500),
    maxNumberOfProblems: config.get<number>("maxNumberOfProblems", 100),

    // Background indexing
    backgroundIndexEnabled: config.get<boolean>("backgroundIndex.enabled", true),
    backgroundIndexBatchSize: config.get<number>("backgroundIndex.batchSize", 8),

    // Pike worker lifecycle
    workerRequestTimeoutMs: config.get<number>("worker.requestTimeoutMs", 5000),
    workerIdleTimeoutMs: config.get<number>("worker.idleTimeoutMs", 300000),
    workerMaxRequestsBeforeRestart: config.get<number>("worker.maxRequestsBeforeRestart", 100),
    workerMaxActiveMinutes: config.get<number>("worker.maxActiveMinutes", 30),
    workerNiceValue: config.get<number>("worker.niceValue", 5),

    // Formatting
    formatInsertFinalNewline: config.get<boolean>("format.insertFinalNewline", true),
    formatOperatorSpacing: config.get<boolean>("format.operatorSpacing", false),
  };
}

// ─── Extension lifecycle ────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // Clear stale output from previous activations (OutputChannel content
  // survives window reloads, which makes it look like multiple versions
  // are running simultaneously).
  outputChannel.clear();

  log("info", "EXT", "[init] step 1/6: activate() called");
  const version = context.extension.packageJSON.version as string;
  log("info", "EXT", `[init] version ${version}`);

  // step 2: language configuration
  try {
    const langConfigPath = context.asAbsolutePath("language-configuration.json");
    const langConfig = JSON.parse(fs.readFileSync(langConfigPath, "utf8"));
    context.subscriptions.push(
      vscode.languages.setLanguageConfiguration("pike", langConfig),
    );
    log("info", "EXT", "[init] step 2/6: language configuration loaded");
  } catch (err) {
    log("info", "EXT", `[init] step 2/6: language-configuration.json not loaded — ${(err as Error).message}`);
  }

  // step 3: tree-sitter syntactic provider
  log("info", "EXT", "[init] step 3/6: creating tree-sitter syntactic provider (async init)");
  const syntacticProvider = new TreeSitterSyntacticProvider(
    context,
    (message: string) => log("info", "TREE-SITTER", message),
  );
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: "pike" },
      syntacticProvider,
      syntacticProvider.legend,
    ),
  );
  log("info", "EXT", "[init] step 3/6: tree-sitter provider registered (init runs in background)");

  // step 4: status bar
  updateStatusBar(State.Starting);
  statusBarItem.command = "workbench.action.output.toggleOutput";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  log("info", "EXT", "[init] step 4/6: status bar created");

  const serverModule = context.asAbsolutePath(path.join("server", "dist", "server.mjs"));


  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.stdio,
      options: { env: { PIKE_LSP_STDIO: "1" } },
    },
    debug: {
      module: serverModule,
      transport: TransportKind.stdio,
      options: {
        execArgv: ["--nolazy", "--inspect=6009"],
        env: { PIKE_LSP_STDIO: "1" },
      },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: "file", language: "pike" },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{pike,pmod,mmod}"),
    },
    initializationOptions: getSettings(),
    // Route server errors through our custom handler (no popup spam).
    errorHandler: makeErrorHandler("SERVER"),
    // Share our LogOutputChannel so the LanguageClient doesn't create
    // a second one with the same name.
    outputChannel,
  };

  // step 5: create and start LanguageClient
  log("info", "EXT", "[init] step 5/6: creating LanguageClient");
  client = new LanguageClient(
    "pikeLanguageServer",
    "Pike Language Server",
    serverOptions,
    clientOptions,
  );

  // Listen for state transitions to update status bar.
  client.onDidChangeState((event: StateChangeEvent) => {
    updateStatusBar(event.newState);
    const label = event.newState === State.Starting ? "Starting"
      : event.newState === State.Running ? "Running"
      : event.newState === State.Stopped ? "Stopped"
      : `unknown(${event.newState})`;
    log("info", "CLIENT", `[init] state change: ${label}`);
  });

  log("info", "EXT", "[init] step 5/6: starting server process...");
  client.start();

  // Apply initial trace setting.
  applyTraceSetting(client);

  // step 6: register commands and notification handlers
  log("info", "EXT", "[init] step 6/6: registering commands and notification handlers");

  client.onNotification(
    "pike/errorCount",
    (params: { count: number }) => {
      setErrorCount(params.count);
    },
  );

  // Server log lines — written to the same output channel with [SERVER] tag
  // so the format is consistent with client-side logs.
  client.onNotification(
    "pike/log",
    (params: { level: string; lines: string[] }) => {
      const level = params.level === "WARN" ? "warn"
        : params.level === "ERROR" ? "error"
        : params.level === "DEBUG" ? "debug"
        : "info";
      for (const line of params.lines) {
        log(level, "SERVER", line);
      }
    },
  );

  // Register a command that shows the output channel and resets error count.
  // The user can run this from the Command Palette to see full error details.
  context.subscriptions.push(
    vscode.commands.registerCommand("pike.showErrorLog", () => {
      outputChannel.show(true);
      setErrorCount(0); // Dismiss badge on view
    }),
  );

  // CodeLens "N references" command: trigger VSCode's built-in references
  // peek UI at the clicked lens position.
  context.subscriptions.push(
    vscode.commands.registerCommand("pike.showReferences", (uri, position) => {
      // VSCode's executeReferenceProvider triggers the same UI as Shift+F12.
      vscode.commands.executeCommand(
        "vscode.executeReferenceProvider",
        vscode.Uri.parse(uri),
        new vscode.Position(position.line, position.character),
      );
    }),
  );

  // Keep status bar updated when error count changes.
  onErrorCountChange((count) => {
    updateStatusBarWithErrors(State.Running, count);
  });

  // Restart the server when settings change.
  // Guard against rapid-fire config changes creating duplicate clients.
  let restarting = false;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("pike.languageServer")) {
        if (restarting) return;
        restarting = true;
        log("info", "EXT", "Settings changed — restarting server...");
        client?.stop().then(() => {
          client = new LanguageClient(
            "pikeLanguageServer",
            "Pike Language Server",
            serverOptions,
            {
              ...clientOptions,
              initializationOptions: getSettings(),
              // Re-apply custom error handler after restart.
              errorHandler: makeErrorHandler("SERVER"),
              // Re-share the output channel.
              outputChannel,
            },
          );
          client.onDidChangeState((ev: StateChangeEvent) => {
            updateStatusBar(ev.newState);
          });
          client.start();
          applyTraceSetting(client);
        }).finally(() => {
          restarting = false;
        });
      }
    }),
  );

  log("info", "EXT", "[init] activate() complete — server starting in background");
}

export function deactivate(): Thenable<void> | undefined {
  log("info", "EXT", "deactivate() — shutting down");
  return client?.stop();
}
