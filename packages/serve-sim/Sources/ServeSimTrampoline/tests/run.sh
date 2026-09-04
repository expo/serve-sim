#!/bin/bash
# Compiles and runs the trampoline parsing tests on the host, then runs clang's
# static analyzer over the shipped source. The dylib itself is built for the
# simulator; this builds the same code for the host so it can be exercised
# without a device.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

BIN="$OUT_DIR/trampoline-test"

xcrun clang \
    -std=c11 \
    -g -O1 \
    -Wall -Wextra -Werror -Wconversion -Wshadow \
    -fsanitize=address,undefined \
    -fno-omit-frame-pointer \
    -fno-sanitize-recover=all \
    -o "$BIN" \
    "$HERE/trampoline-test.c"

"$BIN"

xcrun clang \
    --analyze \
    -Xclang -analyzer-output=text \
    -std=c11 \
    -Wall -Wextra -Wconversion -Wshadow \
    -o "$OUT_DIR/analysis" \
    "$HERE/../serve-sim-trampoline.c"

echo "analyzer clean"
