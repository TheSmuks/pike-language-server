/**
 * Pike Language Server — VSCode extension entry point.
 *
 * Starts the LSP server as a child process communicating over stdio.
 */

import * as path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

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

export function activate(context: vscode.ExtensionContext): void {
  const serverModule = context.asAbsolutePath(
    path.join("server", "dist", "server.js"),
  );

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: {
      module: serverModule,
      transport: TransportKind.stdio,
      options: { execArgv: ["--nolazy", "--inspect=6009"] },
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
  };

  client = new LanguageClient(
    "pikeLanguageServer",
    "Pike Language Server",
    serverOptions,
    clientOptions,
  );


  // Restart the server when settings change
  // Guard against rapid-fire config changes creating duplicate clients
  let restarting = false;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("pike.languageServer")) {
        if (restarting) return;
        restarting = true;
        client?.stop().then(() => {
          client = new LanguageClient(
            "pikeLanguageServer",
            "Pike Language Server",
            serverOptions,
            { ...clientOptions, initializationOptions: getSettings() },
          );
          client.start();
        }).finally(() => {
          restarting = false;
        });
      }
    }),
  );

  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
