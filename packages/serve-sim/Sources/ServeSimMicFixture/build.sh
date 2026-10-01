#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:-$HERE/../../dist/capability-loader}"
mkdir -p "$OUT_DIR"

SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
APP="$OUT_DIR/ServeSimMicFixture.app"

rm -rf "$APP"
mkdir -p "$APP"

xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=17.0 \
    -isysroot "$SDK" \
    -fobjc-arc \
    -O2 \
    -Wall -Wextra -Werror -Wshadow \
    -framework UIKit -framework Foundation -framework AVFoundation -framework AudioToolbox \
    -o "$APP/ServeSimMicFixture" \
    "$HERE/serve-sim-mic-fixture.m"

cp "$HERE/Info.plist" "$APP/Info.plist"
codesign --force --sign - --timestamp=none "$APP" >/dev/null

echo "$APP"
