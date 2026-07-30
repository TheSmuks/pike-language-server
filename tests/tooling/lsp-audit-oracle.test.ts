import { test, expect } from "bun:test";
import { isOurDefect, parseOracleOutput } from "../../tools/lsp-audit/oracle";

test("ok and semantic mean the source is valid, so the defect is ours", () => {
  expect(isOurDefect("ok")).toBe(true);
  expect(isOurDefect("semantic")).toBe(true);
  expect(isOurDefect("cpp_error")).toBe(true);
});

test("syntax means Pike rejects it too, so it is not our defect", () => {
  expect(isOurDefect("syntax")).toBe(false);
});

test("an unavailable oracle never asserts a defect either way", () => {
  expect(isOurDefect("unavailable")).toBe(false);
  expect(isOurDefect("unreadable")).toBe(false);
});

test("parses one JSON object per line, keyed by corpus-relative path", () => {
  const stdout = [
    '{"file":"/corpus/server/modules/tags/rxmltags.pike","verdict":"semantic","diagnostics":[]}',
    '{"file":"/corpus/server/base_server/roxen.pike","verdict":"ok","diagnostics":[]}',
    "",
  ].join("\n");

  const parsed = parseOracleOutput(stdout);
  expect(parsed.get("server/modules/tags/rxmltags.pike")?.verdict).toBe("semantic");
  expect(parsed.get("server/base_server/roxen.pike")?.verdict).toBe("ok");
});

test("ignores non-JSON noise on stdout", () => {
  const parsed = parseOracleOutput('warning: something\n{"file":"/corpus/a.pike","verdict":"ok"}\n');
  expect(parsed.size).toBe(1);
});
