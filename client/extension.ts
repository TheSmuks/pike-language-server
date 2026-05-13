/**
 * Pike Language Server — VSCode extension entry point.
 *
 * Starts the LSP server as a child process communicating over stdio.
 */

// Injected at build time via esbuild --define. Falls back to "dev" for
// unbundled runs (bun test, typecheck).
declare const BUILD_NUMBER: string | undefined;

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
} from "vscode-languageclient/node";

import { TreeSitterSyntacticProvider } from "./treeSitterProvider";
import {
  setErrorCount,
  getErrorCount,
  onErrorCountChange,
} from "./errorNotificationState";

let client: LanguageClient | undefined;

// ─── Observability ──────────────────────────────────────────────────────────

/** Output channel capturing extension lifecycle and server events. */



const outputChannel = vscode.window.createOutputChannel("Pike Language Server");
/** Status bar item reflecting server state. */
const statusBarItem = vscode.window.createStatusBarItem(
  vscode.StatusBarAlignment.Left,
  /* priority */ 99,
);

/**
 * Log a timestamped message to the output channel.
 * `log: true` channel hides the VSCode timestamp; we add our own.
 */
function log(label: string, message: string): void {
  const ts = new Date().toISOString().substring(11, 23); // HH:MM:SS.mmm
  outputChannel.appendLine(`[${ts}] [${label}] ${message}`);
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
      log(label, `Server error during ${method}`);
      return { action: ErrorAction.Continue };
    },

    closed(): CloseHandlerResult {
      log(label, "Server process exited");
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
  };
}

// ─── Extension lifecycle ────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  log("EXT", "[init] step 1/6: activate() called");
  const version = context.extension.packageJSON.version as string;
  const buildId = typeof BUILD_NUMBER !== "undefined" ? BUILD_NUMBER : "dev";
  log("EXT", `[init] version ${version}+${buildId}`);

  // step 2: language configuration
  try {
    const langConfigPath = context.asAbsolutePath("language-configuration.json");
    const langConfig = JSON.parse(fs.readFileSync(langConfigPath, "utf8"));
    context.subscriptions.push(
      vscode.languages.setLanguageConfiguration("pike", langConfig),
    );
    log("EXT", "[init] step 2/6: language configuration loaded");
  } catch (err) {
    log("EXT", `[init] step 2/6: language-configuration.json not loaded — ${(err as Error).message}`);
  }

  // step 3: tree-sitter syntactic provider
  log("EXT", "[init] step 3/6: creating tree-sitter syntactic provider (async init)");
  const syntacticProvider = new TreeSitterSyntacticProvider(context);
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: "pike" },
      syntacticProvider,
      syntacticProvider.legend,
    ),
  );
  log("EXT", "[init] step 3/6: tree-sitter provider registered (init runs in background)");

  // step 4: status bar
  updateStatusBar(State.Starting);
  statusBarItem.command = "workbench.action.output.toggleOutput";
  context.subscriptions.push(statusBarItem);
  log("EXT", "[init] step 4/6: status bar created");

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
    // Share the existing output channel so the LanguageClient does not create
    // a second one with the same name (which would cause duplicate log output).
    outputChannel,
  };

  // step 5: create and start LanguageClient
  log("EXT", "[init] step 5/6: creating LanguageClient");
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
    log("CLIENT", `[init] state change: ${label}`);
  });

  log("EXT", "[init] step 5/6: starting server process...");
  client.start();

  // step 6: register commands and notification handlers
  log("EXT", "[init] step 6/6: registering commands and notification handlers");

  client.onNotification(
    "pike/errorCount",
    (params: { count: number }) => {
      setErrorCount(params.count);
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
        log("EXT", "Settings changed — restarting server...");
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
              // Share the output channel to avoid duplicate log entries.
              outputChannel,
            },
          );
          client.onDidChangeState((ev: StateChangeEvent) => {
            updateStatusBar(ev.newState);
          });
          client.start();
        }).finally(() => {
          restarting = false;
        });
      }
    }),
  );

  log("EXT", "[init] activate() complete — server starting in background");
}

export function deactivate(): Thenable<void> | undefined {
  log("EXT", "deactivate() — shutting down");
  return client?.stop();
}
