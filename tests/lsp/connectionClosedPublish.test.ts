import { describe, expect, test, beforeAll, beforeEach } from "bun:test";
import { DiagnosticManager } from "../../server/src/features/diagnosticManager";
import { errorLog } from "../../server/src/util/errorLog";

/**
 * A client that disconnects without completing `shutdown` — a crash, a kill, or
 * an editor closing the transport — leaves every publish path pointed at a dead
 * connection. That is an ordinary end of session, not a fault of the file being
 * edited, so it must not land in the error log the status bar counts.
 */
function closedConnection() {
  const closed = () => {
    throw new Error("Connection is closed.");
  };
  return {
    sendDiagnostics: closed,
    sendNotification: closed,
    console: { error: () => {}, warn: () => {}, info: () => {}, log: () => {} },
  } as never;
}

function managerOn(connection: never, uri: string, text: string) {
  return new DiagnosticManager({
    worker: { diagnose: async () => ({ diagnostics: [] }) } as never,
    documents: {
      get: () => ({ uri, version: 1, getText: () => text }),
      all: () => [],
    } as never,
    connection,
    index: { pikePaths: { modulePaths: [], includePaths: [], programPaths: [] } } as never,
    pikeCache: new Map() as never,
    cacheSet: () => {},
    mode: "off",
  } as never);
}

describe("publishing into a closed connection", () => {
  const uri = "file:///tmp/closed-connection-probe.pike";

  beforeAll(async () => {
    const { initParser } = await import("../../server/src/parser");
    await initParser();
  });

  beforeEach(() => {
    errorLog.clear?.();
  });

  test("a disconnect during an in-flight edit is not reported as an error", () => {
    const before = errorLog.errorCount();
    const manager = managerOn(closedConnection(), uri, "int main() { return 0; }\n");

    expect(() => manager.onDidChange(uri)).not.toThrow();
    expect(errorLog.errorCount()).toBe(before);

    manager.dispose();
  });

  test("the manager stops publishing once it has seen the connection close", () => {
    let attempts = 0;
    const connection = {
      sendDiagnostics: () => {
        attempts += 1;
        throw new Error("Connection is closed.");
      },
      sendNotification: () => {
        throw new Error("Connection is closed.");
      },
      console: { error: () => {}, warn: () => {}, info: () => {}, log: () => {} },
    } as never;

    const manager = managerOn(connection, uri, "int main() { return 0; }\n");
    manager.onDidChange(uri);
    manager.onDidChange(uri);
    manager.onDidChange(uri);

    expect(attempts).toBe(1);
    manager.dispose();
  });
});
