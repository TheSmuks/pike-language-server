#!/usr/bin/env bash
set -euo pipefail

# Build single-file server binaries — no Bun, no Node, no build step for users.
#
# Usage:
#   bash scripts/build-binary.sh                # host platform only
#   bash scripts/build-binary.sh --all          # every release target
#   bash scripts/build-binary.sh bun-linux-x64  # one named target
#
# Output: dist-binary/pike-language-server-<platform>[.exe]
#
# compileEntry.ts embeds both WASM blobs into the executable; the JSON indexes
# are `import`ed and bundled by Bun automatically. The result needs nothing
# beside it on disk.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$ROOT/dist-binary"
ENTRY="$ROOT/server/src/compileEntry.ts"

# Bun compile target -> released artifact suffix.
ALL_TARGETS=(
  "bun-linux-x64:linux-x64"
  "bun-linux-arm64:linux-arm64"
  "bun-darwin-x64:darwin-x64"
  "bun-darwin-arm64:darwin-arm64"
  "bun-windows-x64:windows-x64.exe"
)

host_target() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Linux) os="linux" ;;
    Darwin) os="darwin" ;;
    *) echo "unsupported host OS: $os" >&2; exit 1 ;;
  esac
  case "$arch" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "unsupported host arch: $arch" >&2; exit 1 ;;
  esac
  echo "bun-${os}-${arch}:${os}-${arch}"
}

build_one() {
  local target="${1%%:*}"
  local suffix="${1##*:}"
  local out="$OUT_DIR/pike-language-server-$suffix"
  echo "  building $target -> $(basename "$out")"
  bun build --compile --target="$target" "$ENTRY" --outfile "$out"
  # Bun appends .exe for windows targets; keep the name we advertise.
  if [ "$target" = "bun-windows-x64" ] && [ -f "$out.exe" ]; then
    mv "$out.exe" "$out"
  fi
}

mkdir -p "$OUT_DIR"

if [ "${1:-}" = "--all" ]; then
  targets=("${ALL_TARGETS[@]}")
elif [ -n "${1:-}" ]; then
  targets=()
  for entry in "${ALL_TARGETS[@]}"; do
    [ "${entry%%:*}" = "$1" ] && targets+=("$entry")
  done
  if [ ${#targets[@]} -eq 0 ]; then
    echo "unknown target: $1" >&2
    printf 'known targets: %s\n' "$(printf '%s ' "${ALL_TARGETS[@]%%:*}")" >&2
    exit 1
  fi
else
  targets=("$(host_target)")
fi

echo "Building server binaries to $OUT_DIR..."
for entry in "${targets[@]}"; do
  build_one "$entry"
done

echo "Binary build complete:"
ls -lh "$OUT_DIR"
