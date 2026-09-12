#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# Skip a fixture this checkout does not have.
for BUILD_SCRIPT in \
  "$HERE/ServeSimProbe/build.sh" \
  "$HERE/ServeSimLaunchFixture/build.sh" \
  "$HERE/SimNetProbe/build.sh"
do
  if [ -f "$BUILD_SCRIPT" ]; then
    bash "$BUILD_SCRIPT"
  fi
done
