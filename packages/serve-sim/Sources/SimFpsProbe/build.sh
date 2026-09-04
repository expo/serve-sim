#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simfps}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DYLIB="$OUT_DIR/libSimFpsProbe.dylib"

# Apple silicon simulators run arm64 processes; no Intel slice is shipped.
xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -dynamiclib \
    -fobjc-arc \
    -fmodules \
    -I "$HERE/include" \
    -framework Foundation \
    -framework UIKit \
    -framework QuartzCore \
    -install_name "@rpath/libSimFpsProbe.dylib" \
    -o "$DYLIB" \
    "$HERE/SimFpsProbe.m"

echo "Built: $DYLIB"
file "$DYLIB"

NODE_INC="$(node -p "require('node:path').join(require('node:path').dirname(process.execPath), '..', 'include', 'node')")"
if [ ! -f "$NODE_INC/node_api.h" ]; then
  echo "node_api.h not found at $NODE_INC (need a Node install with headers)" >&2
  exit 1
fi

HOST_SDK="$(xcrun --sdk macosx --show-sdk-path)"
NODE_ADDON="$OUT_DIR/fps-shm.node"
xcrun --sdk macosx clang \
    -arch arm64 \
    -mmacosx-version-min=14.0 \
    -isysroot "$HOST_SDK" \
    -dynamiclib \
    -undefined dynamic_lookup \
    -I "$NODE_INC" \
    -I "$HERE/include" \
    -o "$NODE_ADDON" \
    "$HERE/FpsShmNode.c"
strip -x "$NODE_ADDON"
codesign -s - -f "$NODE_ADDON" >/dev/null
codesign --verify --strict "$NODE_ADDON"

echo "Built: $NODE_ADDON"
file "$NODE_ADDON"
