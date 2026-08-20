#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simnet}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DYLIB="$OUT_DIR/libSimNetProxy.dylib"

# Apple silicon simulators run arm64 processes; no Intel slice is shipped.
xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -dynamiclib \
    -fobjc-arc \
    -fmodules \
    -framework Foundation \
    -framework CFNetwork \
    -install_name "@rpath/libSimNetProxy.dylib" \
    -o "$DYLIB" \
    "$HERE/SimNetProxy.m"

echo "Built: $DYLIB"
file "$DYLIB"
