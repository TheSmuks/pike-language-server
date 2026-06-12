import { describe, test, expect, afterEach } from "bun:test";
import {
  logInfo,
  logResourceEvent,
  setLogPathRedactionEnabled,
} from "../../server/src/util/errorLog";

interface SentNotification {
  method: string;
  params: { level: string; lines: string[] };
}

function makeConnection(): { connection: any; sent: SentNotification[] } {
  const sent: SentNotification[] = [];
  const connection = {
    sendNotification(method: string, params: { level: string; lines: string[] }) {
      sent.push({ method, params });
    },
    console: {
      error() {},
    },
  };
  return { connection, sent };
}

describe("server log path redaction setting", () => {
  afterEach(() => {
    setLogPathRedactionEnabled(true);
  });

  test("redacts file paths by default", () => {
    const { connection, sent } = makeConnection();

    logInfo(connection, "opened file:///home/alice/project/main.pike at /home/alice/project/main.pike");

    expect(sent[0]?.params.lines[0]).toBe("opened <file-uri> at <path>");
  });

  test("preserves file paths when redaction is disabled", () => {
    const { connection, sent } = makeConnection();
    setLogPathRedactionEnabled(false);

    logInfo(connection, "opened file:///home/alice/project/main.pike at /home/alice/project/main.pike");

    expect(sent[0]?.params.lines[0]).toBe(
      "opened file:///home/alice/project/main.pike at /home/alice/project/main.pike",
    );
  });
});

// ---------------------------------------------------------------------------
// T095: Standardized resource log signals
// ---------------------------------------------------------------------------

describe("US5: Standardized resource log signals (Phase 7, T095)", () => {
  test("logResourceEvent emits structured log with state and details", () => {
    const { connection, sent } = makeConnection();

    logResourceEvent(connection, "degraded", {
      reason: "memory budget exceeded",
      heapUsedMb: 450,
      heapTotalMb: 512,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("pike/log");
    expect(sent[0].params.level).toBe("WARN");

    const msg = sent[0].params.lines.join("\n");
    expect(msg).toContain("degraded");
    expect(msg).toContain("memory budget exceeded");
    expect(msg).toContain("heapUsedMb=450");
    expect(msg).toContain("heapTotalMb=512");
  });

  test("logResourceEvent for hibernation state", () => {
    const { connection, sent } = makeConnection();

    logResourceEvent(connection, "hibernating", {
      reason: "idle timeout (no open documents, 15min inactivity)",
    });

    const msg = sent[0].params.lines.join("\n");
    expect(msg).toContain("hibernating");
    expect(msg).toContain("idle timeout");
  });

  test("logResourceEvent for demotion state", () => {
    const { connection, sent } = makeConnection();

    logResourceEvent(connection, "demoted", {
      reason: "heap pressure",
      demotedCount: 42,
      retainedCount: 15,
    });

    const msg = sent[0].params.lines.join("\n");
    expect(msg).toContain("demoted");
    expect(msg).toContain("demotedCount=42");
    expect(msg).toContain("retainedCount=15");
  });

  test("logResourceEvent for worker restart", () => {
    const { connection, sent } = makeConnection();

    logResourceEvent(connection, "active", {
      reason: "worker restarted after crash",
      crashCount: 2,
    });

    const msg = sent[0].params.lines.join("\n");
    expect(msg).toContain("worker restarted");
    expect(msg).toContain("crashCount=2");
  });

  test("logResourceEvent omits undefined fields", () => {
    const { connection, sent } = makeConnection();

    logResourceEvent(connection, "active", {
      reason: "recovered",
    });

    const msg = sent[0].params.lines.join("\n");
    expect(msg).not.toContain("heapUsedMb");
    expect(msg).not.toContain("demotedCount");
  });
});
