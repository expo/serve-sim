#!/bin/bash
# Builds serve-sim-native.node — the in-process N-API addon that replaces the
# spawned serve-sim-bin helper. The JS bindings are written in Swift with
# node-swift (see ../../Package.swift and sim-module.swift).
#
# We opt into the new `swiftbuild` build system, because it supports building universal
# binaries with macros, which neither the legacy `native` build system nor the
# perennially-janky legacy `xcode` build system had support for.
#
# napi_* stay undefined and resolve against the host (Node/Bun) at dlopen via
# `-undefined dynamic_lookup`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PKG="$(cd "$HERE/../.." && pwd)"          # packages/serve-sim (Package.swift root)
OUT_DIR="${1:-$PKG/dist/native}"
BUILD_DIR="$PKG/.build"
PRODUCT="serve-sim-native"
WEBRTC_FRAMEWORK_NAME="LiveKitWebRTC.framework"
mkdir -p "$OUT_DIR"
WEBRTC_RUNTIME_DIR="$(cd "$OUT_DIR/.." && pwd)/bin"
WEBRTC_RUNTIME_FRAMEWORK="$WEBRTC_RUNTIME_DIR/$WEBRTC_FRAMEWORK_NAME"

if [ ! -d "$PKG/node_modules/node-swift" ]; then
  echo "node-swift not found at $PKG/node_modules/node-swift (run: bun install)" >&2
  exit 1
fi

build_flags=(
  -c release
  --product "$PRODUCT"
  --package-path "$PKG"
  --build-path "$BUILD_DIR"
  --build-system swiftbuild
)
swift build "${build_flags[@]}" >&2
DYLIB="$(swift build --show-bin-path "${build_flags[@]}")/lib${PRODUCT}.dylib"
if [ ! -f "$DYLIB" ]; then
  echo "Expected build product not found at $DYLIB" >&2
  exit 1
fi

WEBRTC_ARTIFACT_FRAMEWORK="$(find "$BUILD_DIR/artifacts" -path "*/macos-arm64_x86_64/$WEBRTC_FRAMEWORK_NAME" -type d -print -quit)"
if [ -z "$WEBRTC_ARTIFACT_FRAMEWORK" ]; then
  WEBRTC_ARTIFACT_FRAMEWORK="$(find "$BUILD_DIR/artifacts" -name "$WEBRTC_FRAMEWORK_NAME" -type d -print -quit)"
fi
if [ -z "$WEBRTC_ARTIFACT_FRAMEWORK" ]; then
  echo "Expected LiveKitWebRTC framework artifact not found under $BUILD_DIR/artifacts" >&2
  exit 1
fi

rm -rf "$WEBRTC_RUNTIME_FRAMEWORK"
mkdir -p "$WEBRTC_RUNTIME_DIR"
cp -a "$WEBRTC_ARTIFACT_FRAMEWORK" "$WEBRTC_RUNTIME_FRAMEWORK"

OUT="$OUT_DIR/${PRODUCT}.node"
cp -a "$DYLIB" "$OUT"
strip -x "$OUT"
install_name_tool \
  -change "@rpath/LiveKitWebRTC.framework/LiveKitWebRTC" \
  "@loader_path/../bin/LiveKitWebRTC.framework/Versions/A/LiveKitWebRTC" \
  "$OUT"
codesign -s - -f "$OUT" 2>/dev/null || true

echo "Built: $OUT"
lipo -info "$OUT"
