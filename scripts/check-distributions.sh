#!/usr/bin/env bash
set -euo pipefail

# Verify every release artifact actually serves LSP, the way a user gets it.
#
# Usage:
#   bash scripts/check-distributions.sh            # all four
#   bash scripts/check-distributions.sh tarball    # one of: tarball npm binary vsix
#
# Each artifact is exercised OUTSIDE the repository, so a bundle that only works
# because it can reach the checkout's node_modules fails here. That is not
# hypothetical: the standalone bundle marked vscode-languageserver external and
# died with "Cannot find module 'vscode-languageserver-protocol/lib/common/api'"
# the moment it was copied anywhere else.
#
# The feature sweep is scripts/check-helix-lsp.mjs, pointed at each artifact via
# PIKE_LSP_SERVER_CMD, so all four are held to the same 13-feature bar.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

CHECKOUT="$(git -C "$ROOT" rev-parse --show-toplevel 2>/dev/null || true)"
CHECKOUT="${CHECKOUT:-$ROOT}"
case "$WORK" in
  "$CHECKOUT"/*) echo "TMPDIR is inside the checkout ($WORK) — masking would hide the artifacts" >&2; exit 2 ;;
esac

FAILED=0

banner() { printf '\n=== %s ===\n' "$1"; }

sweep() { # $1 = JSON argv array
  if PIKE_LSP_SERVER_CMD="$1" node "$SCRIPT_DIR/check-helix-lsp.mjs"; then
    return 0
  fi
  FAILED=1
  return 0
}

check_tarball() {
  banner "tarball (bun/node + extracted archive)"
  bash "$SCRIPT_DIR/build-standalone.sh" >/dev/null
  bash "$SCRIPT_DIR/build-tarball.sh" >/dev/null
  local tgz
  tgz="$(ls "$ROOT"/dist-tarball/pike-language-server-standalone-*.tar.gz)"
  mkdir -p "$WORK/tar"
  tar xzf "$tgz" -C "$WORK/tar"
  sweep "[\"node\",\"$WORK/tar/pike-language-server/server.js\",\"--stdio\"]"
}

check_vsix() {
  banner "vsix (extension package, node runtime)"
  bash "$SCRIPT_DIR/build-vsix.sh" >/dev/null
  local vsix
  vsix="$(cat "$ROOT/out/.latest-vsix")"
  mkdir -p "$WORK/vsix"
  unzip -q -o "$vsix" -d "$WORK/vsix"
  # The extension's own server, run the way the client spawns it. This is the
  # distribution the audit sweep never covered, and the one users actually get:
  # the Pike worker went missing from three artifacts once already.
  sweep "[\"node\",\"$WORK/vsix/extension/server/dist/server.mjs\",\"--stdio\"]"
}

check_npm() {
  banner "npm package (global install, node runtime)"
  bash "$SCRIPT_DIR/build-standalone.sh" >/dev/null
  bash "$SCRIPT_DIR/build-npm-package.sh" >/dev/null
  local tgz
  tgz="$(ls "$ROOT"/dist-npm/pike-language-server-*.tgz)"
  npm install -g --prefix "$WORK/npm" "$tgz" >/dev/null 2>&1
  sweep "[\"$WORK/npm/bin/pike-language-server\",\"--stdio\"]"
}

host_suffix() {
  local os arch
  case "$(uname -s)" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    *) echo "unsupported host OS: $(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "unsupported host arch: $(uname -m)" >&2; exit 1 ;;
  esac
  echo "${os}-${arch}"
}

# `bun build --compile` freezes __dirname into the binary at build time, so
# every path derived from it resolves on the build machine by construction and
# nowhere else. That is not hypothetical either: from ~v0.8.30 the Pike worker
# was spawned with the builder's checkout as its cwd, so every released binary
# died ~3s into every session on a user's machine — while this script reported
# 13/13, because it only ever ran where those paths existed.

report_baked_paths() { # $1 = binary
  if ! command -v strings >/dev/null 2>&1; then
    echo "  (strings unavailable — skipping the baked-path scan)"
    return 0
  fi
  local hits
  hits="$(strings -a "$1" | grep -F -e "$CHECKOUT" -e "/home/runner/work" | sort -u | head -5 || true)"
  if [ -z "$hits" ]; then
    echo "  no build-machine paths baked into the binary"
    return 0
  fi
  # Embedded assets can carry paths harmlessly; only using one at runtime is
  # fatal, which is what the masked run below decides.
  echo "  build-machine paths baked into the binary:"
  printf '%s\n' "$hits" | while read -r line; do echo "    $line"; done
}

write_liveness_probe() { # $1 = destination .mjs
  cat > "$1" <<'PROBE'
// Two assertions the feature sweep cannot make.
//
// 1. The server is still serving well past the unconditional Pike probe that
//    runs after `initialized` — the ~3s window in which a bad spawn cwd killed
//    the process. Answering `initialize` proves nothing about that.
// 2. The Pike worker really ran. Handling the spawn failure gracefully turns
//    the crash into silent degradation: the sweep is Pike-free and would still
//    print 13/13 with the worker dead. Only a diagnostic carrying the compiler's
//    own `source: "pike"` proves the worker compiled anything (parse and lint
//    diagnostics are "pike-lsp"/"pike-lsp-lint" and arrive without Pike).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "./tools/lsp-audit/lsp-stdio.mjs";

const [bin, ...args] = JSON.parse(process.env.PIKE_LSP_SERVER_CMD);
const dir = mkdtempSync(join(tmpdir(), "pike-masked-"));
const env = { ...process.env };
delete env.PIKE_LSP_STDIO;

const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env });
let exited = null;
let stderr = "";
let out = "";
proc.stderr.on("data", (d) => { stderr += d.toString(); });
proc.stdout.on("data", (d) => { out += d.toString(); });
proc.on("exit", (code, signal) => { exited = `code=${code} signal=${signal}`; });

const { send, request } = createClient(proc);
await request("initialize", {
  processId: process.pid,
  rootUri: `file://${dir}`,
  workspaceFolders: [{ name: "masked", uri: `file://${dir}` }],
  capabilities: {},
});
send({ jsonrpc: "2.0", method: "initialized", params: {} });

const file = join(dir, "degraded.pike");
const uri = `file://${file}`;
const text = "int main() {\n  int x = undefined_identifier_xyz;\n  return 0;\n}\n";
writeFileSync(file, text);
send({ jsonrpc: "2.0", method: "textDocument/didOpen", params: {
  textDocument: { uri, languageId: "pike", version: 1, text },
} });
await new Promise((r) => setTimeout(r, 8000));

if (exited) {
  console.error(`  FAIL  server exited (${exited}) within 8s of initialized`);
  console.error(stderr.split("\n").slice(-20).join("\n"));
  process.exit(1);
}
await request("textDocument/documentSymbol", { textDocument: { uri } });
console.log("  PASS  still serving 8s after initialized");

const pikeBin = process.env.PIKE_BINARY ?? "pike";
if (spawnSync(pikeBin, ["--version"]).status !== 0) {
  console.log(`  SKIP  no ${pikeBin} on PATH — cannot tell a live worker from a degraded one`);
  proc.kill();
  process.exit(0);
}

const deadline = Date.now() + 25000;
const compiled = () => out.includes('"source":"pike"');
while (Date.now() < deadline && !compiled()) await new Promise((r) => setTimeout(r, 250));
if (!compiled()) {
  console.error("  FAIL  no Pike compiler diagnostic in 25s — the worker degraded silently");
  console.error(out.slice(-1500));
  console.error(stderr.split("\n").slice(-20).join("\n"));
  process.exit(1);
}
console.log("  PASS  Pike worker compiled the fixture (compiler diagnostic received)");
proc.kill();
process.exit(0);
PROBE
}

# How to get a private mount namespace. Unprivileged `unshare -rm` covers a
# developer box; GitHub's runners restrict unprivileged user namespaces but give
# passwordless sudo, so try that too — otherwise this whole guard silently
# becomes local-only. `sudo -n` never prompts, so it cannot hang a local run.
mask_command() {
  if unshare -rm true >/dev/null 2>&1; then
    echo "unshare -rm"
  elif sudo -n unshare -m true >/dev/null 2>&1; then
    # No -r under sudo: we are already root, and the extra user namespace it
    # would create is what makes the tmpfs mount fail on GitHub runners.
    echo "sudo -n unshare -m"
  fi
}

masked_binary_check() { # $1 = binary, already outside the checkout
  local masked="$WORK/masked"
  mkdir -p "$masked/scripts" "$masked/tools/lsp-audit"
  cp "$SCRIPT_DIR/check-helix-lsp.mjs" "$masked/scripts/"
  cp "$ROOT/tools/lsp-audit/lsp-stdio.mjs" "$masked/tools/lsp-audit/"
  write_liveness_probe "$masked/probe.mjs"

  local -a mask
  read -r -a mask <<< "$(mask_command)"
  if [ "${#mask[@]}" -eq 0 ]; then
    printf '!!! WARNING: no way to create a mount namespace here — neither\n' >&2
    printf '!!! `unshare -rm` nor `sudo -n unshare -rm` works.\n' >&2
    printf '!!! The binary was NOT run off its build machine, so a baked\n' >&2
    printf '!!! build-machine path would go undetected by this run.\n' >&2
    return 0
  fi

  echo "  running with $CHECKOUT masked by an empty tmpfs (${mask[*]})"
  # The server command is exported inside the shell, not passed through the
  # environment: sudo resets it.
  if "${mask[@]}" sh -c "
        mount -t tmpfs none '$CHECKOUT' || exit 1
        export PIKE_LSP_SERVER_CMD='[\"$1\",\"--stdio\"]'
        node '$masked/probe.mjs' || exit 1
        node '$masked/scripts/check-helix-lsp.mjs' || exit 1"; then
    return 0
  fi
  FAILED=1
}

check_binary() {
  banner "native binary (no runtime required)"
  bash "$SCRIPT_DIR/build-binary.sh" >/dev/null
  local bin
  # Pick the host binary by name. `ls | head -1` would grab darwin-arm64
  # alphabetically and try to execute a macOS build on a Linux runner, once
  # build-binary.sh --all has populated dist-binary/ with every target.
  bin="$ROOT/dist-binary/pike-language-server-$(host_suffix)"
  if [ ! -f "$bin" ]; then
    echo "host binary not found: $bin" >&2
    exit 1
  fi
  # Copy it somewhere with no .wasm beside it: the binary must carry its own
  # assets. Built from server.ts-style on-disk lookup it reported
  # "Parser not initialized" and 2/15 features.
  cp "$bin" "$WORK/pike-language-server"
  chmod +x "$WORK/pike-language-server"
  sweep "[\"$WORK/pike-language-server\",\"--stdio\"]"
  report_baked_paths "$WORK/pike-language-server"
  masked_binary_check "$WORK/pike-language-server"
}

case "${1:-all}" in
  tarball) check_tarball ;;
  npm)     check_npm ;;
  binary)  check_binary ;;
  vsix)    check_vsix ;;
  all)     check_tarball; check_npm; check_binary; check_vsix ;;
  *) echo "unknown target: $1 (want: tarball|npm|binary|vsix|all)" >&2; exit 2 ;;
esac

if [ "$FAILED" -ne 0 ]; then
  printf '\n[FAIL] at least one distribution does not serve LSP\n' >&2
  exit 1
fi
printf '\n[PASS] every checked distribution serves LSP\n'
