#!/usr/bin/env bash
set -euo pipefail

# Verify every release artifact actually serves LSP, the way a user gets it.
#
# Usage:
#   bash scripts/check-distributions.sh            # all three
#   bash scripts/check-distributions.sh tarball    # one of: tarball npm binary
#
# Each artifact is exercised OUTSIDE the repository, so a bundle that only works
# because it can reach the checkout's node_modules fails here. That is not
# hypothetical: the standalone bundle marked vscode-languageserver external and
# died with "Cannot find module 'vscode-languageserver-protocol/lib/common/api'"
# the moment it was copied anywhere else.
#
# The feature sweep is scripts/check-helix-lsp.mjs, pointed at each artifact via
# PIKE_LSP_SERVER_CMD, so all three are held to the same 13-feature bar.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

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
}

case "${1:-all}" in
  tarball) check_tarball ;;
  npm)     check_npm ;;
  binary)  check_binary ;;
  all)     check_tarball; check_npm; check_binary ;;
  *) echo "unknown target: $1 (want: tarball|npm|binary|all)" >&2; exit 2 ;;
esac

if [ "$FAILED" -ne 0 ]; then
  printf '\n[FAIL] at least one distribution does not serve LSP\n' >&2
  exit 1
fi
printf '\n[PASS] every checked distribution serves LSP\n'
