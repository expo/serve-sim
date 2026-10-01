#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simmic}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
DYLIB="$OUT_DIR/libSimMicInjector.dylib"

# Apple silicon simulators run arm64 processes; no Intel slice is shipped.
xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -dynamiclib \
    -fblocks \
    -O2 \
    -Wall -Wextra -Werror \
    -I "$HERE/include" \
    -framework CoreAudio \
    -install_name "@rpath/libSimMicInjector.dylib" \
    -o "$DYLIB" \
    "$HERE/SimMicInjector.c"

echo "Built: $DYLIB"
file "$DYLIB"
