#!/bin/bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simmic}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk macosx --show-sdk-path)"
BIN="$OUT_DIR/serve-sim-mic-helper"

xcrun --sdk macosx clang \
    -arch arm64 \
    -mmacosx-version-min=14.0 \
    -isysroot "$SDK" \
    -fobjc-arc -fmodules \
    -Wall -Wextra -Werror \
    -framework Foundation \
    -framework AVFoundation \
    -O2 \
    -o "$BIN" \
    "$HERE/main.m"

codesign -s - -f "$BIN" 2>/dev/null || true

echo "Built: $BIN"
file "$BIN"
