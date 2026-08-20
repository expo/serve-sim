#!/bin/bash
# Builds the SimNetProbe test app bundle. Test fixture only: it is never shipped, and build.ts does not
# call it — the injection test builds it on demand.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="${1:?usage: build.sh <output-dir>}"
APP="$OUT_DIR/SimNetProbe.app"

mkdir -p "$APP"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"

xcrun --sdk iphonesimulator clang \
    -arch arm64 \
    -mios-simulator-version-min=15.0 \
    -isysroot "$SDK" \
    -fobjc-arc \
    -fmodules \
    -framework UIKit \
    -framework Foundation \
    -o "$APP/SimNetProbe" \
    "$HERE/main.m"

cat > "$APP/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key><string>en</string>
    <key>CFBundleExecutable</key><string>SimNetProbe</string>
    <key>CFBundleIdentifier</key><string>dev.expo.serve-sim.simnet-probe</string>
    <key>CFBundleName</key><string>SimNetProbe</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array>
    <key>MinimumOSVersion</key><string>15.0</string>
    <key>UIDeviceFamily</key><array><integer>1</integer></array>
    <key>UILaunchScreen</key><dict/>
</dict>
</plist>
PLIST

codesign --force --sign - --timestamp=none "$APP" >/dev/null 2>&1 || true

echo "Built: $APP"
