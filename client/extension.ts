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
} from "vscode-languageclient/node";

import { TreeSitterSyntacticProvider } from "./treeSitterProvider";

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

/** Update the status bar to reflect server state. */
function updateStatusBar(state: State): void {
  switch (state) {
    case State.Starting: {
      statusBarItem.text = `$(sync~spin) Pike LSP`;
      statusBarItem.backgroundColor = undefined;
      statusBarItem.color = undefined;
      break;
    }
    case State.Running: {
      statusBarItem.text = `$(zap) Pike LSP`;
      statusBarItem.backgroundColor = undefined;
      statusBarItem.color = undefined;
      break;
    }
    case State.Stopped: {
      statusBarItem.text = `$(warning) Pike LSP`;
      statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      statusBarItem.color = new vscode.ThemeColor("statusBarItem.errorForeground");
      break;
    }
    default: {
      statusBarItem.text = `$(question) Pike LSP`;
      break;
    }
  }
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
  log("EXT", "Activating Pike Language Server...");
  // Language configuration for Pike — client-side, no LSP traffic.
  // Handles Enter, Tab, auto-indent, and surrounding pairs.
  // See client/language-configuration.json for rules.
  try {
    const langConfigPath = context.asAbsolutePath("language-configuration.json");
    const langConfig = JSON.parse(fs.readFileSync(langConfigPath, "utf8"));
    context.subscriptions.push(
      vscode.languages.setLanguageConfiguration("pike", langConfig),
    );
  } catch (err) {
    log("EXT", `Warning: language-configuration.json not loaded: ${(err as Error).message}`);
    log("EXT", "Language configuration (brackets, comments) will use defaults.");
  }

  // Register tree-sitter syntactic token provider.
  // Runs at lower priority than LSP — VSCode merges both providers.
  // Provides instant highlighting for keywords, operators, types, literals
  // without waiting for project analysis.
  const syntacticProvider = new TreeSitterSyntacticProvider(context);
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      { language: "pike" },
      syntacticProvider,
      syntacticProvider.legend,
    ),
  );
  log("EXT", "Tree-sitter syntactic provider registered.");

  // Status bar: show starting state and open output channel on click.
  updateStatusBar(State.Starting);
  statusBarItem.command = "workbench.action.output.toggleOutput";
  context.subscriptions.push(statusBarItem);

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

  client = new LanguageClient(
    "pikeLanguageServer",
    "Pike Language Server",
    serverOptions,
    clientOptions,
  );

  // Listen for state transitions to update status bar.
  client.onDidChangeState((event: StateChangeEvent) => {
    updateStatusBar(event.newState);
    switch (event.newState) {
      case State.Starting:
        log("CLIENT", "State: Starting");
        break;
      case State.Running:
        log("CLIENT", "State: Running");
        break;
      case State.Stopped:
        log("CLIENT", "State: Stopped");
        break;
      default:
        log("CLIENT", `State: unknown(${event.newState})`);
        break;
    }
  });

  log("EXT", "Starting server...");
  client.start();

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
}

export function deactivate(): Thenable<void> | undefined {
  log("EXT", "Shutting down...");
  return client?.stop();
}
