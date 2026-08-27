#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/simpb}"
APP="$OUT_DIR/ServeSimPasteboard.app"
mkdir -p "$APP"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"

# An app bundle, not a plain executable: iOS only serves pasteboard contents to
# a foreground app, so `simctl spawn` cannot read.
xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -fobjc-arc \
    -framework Foundation \
    -framework UIKit \
    -o "$APP/ServeSimPasteboard" \
    "$HERE/sim-pasteboard-app.m"

cp "$HERE/Info.plist" "$APP/Info.plist"

echo "Built: $APP"
file "$APP/ServeSimPasteboard"
