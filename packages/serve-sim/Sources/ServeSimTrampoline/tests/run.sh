#!/bin/bash
# Compiles and runs the trampoline parsing tests on the host, then runs clang's
# static analyzer over the shipped source. The dylib itself is built for the
# simulator; this builds the same code for the host so it can be exercised
# without a device.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$(mktemp -d)"
trap 'rm -rf "$OUT_DIR"' EXIT

# A dylib the load loop can actually open, so the success path runs on the host.
xcrun clang -dynamiclib -O1 -Wall -Wextra -Werror \
    -o "$OUT_DIR/libServeSimHostProbe.dylib" \
    "$HERE/host-probe.c"

xcrun clang \
    -std=c11 \
    -g -O1 \
    -Wall -Wextra -Werror -Wconversion -Wshadow \
    -fsanitize=address,undefined \
    -fno-omit-frame-pointer \
    -fno-sanitize-recover=all \
    -DSERVE_SIM_TEST_DYLIB="\"$OUT_DIR/libServeSimHostProbe.dylib\"" \
    -o "$OUT_DIR/trampoline-test" \
    "$HERE/trampoline-test.c"

"$OUT_DIR/trampoline-test"

# clang --analyze exits 0 even when it reports, and -Werror does not change that,
# so the findings themselves are the signal.
ANALYSIS="$OUT_DIR/analysis.txt"
xcrun clang \
    --analyze \
    -Xclang -analyzer-output=text \
    -std=c11 \
    -Wall -Wextra -Wconversion -Wshadow \
    -o "$OUT_DIR/analysis" \
    "$HERE/../serve-sim-trampoline.c" > "$ANALYSIS" 2>&1 || true

if [ -s "$ANALYSIS" ]; then
  echo "analyzer findings:"
  cat "$ANALYSIS"
  exit 1
fi

echo "analyzer clean"
