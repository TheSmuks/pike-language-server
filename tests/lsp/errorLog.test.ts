import { describe, test, expect, afterEach } from "bun:test";
import {
  logInfo,
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
