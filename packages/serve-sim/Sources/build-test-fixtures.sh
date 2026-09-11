#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# The crash fixture arrives in a separate PR, so build whatever is present.
for BUILD_SCRIPT in \
  "$HERE/ServeSimProbe/build.sh" \
  "$HERE/ServeSimLaunchFixture/build.sh" \
  "$HERE/ServeSimCrashFixture/build.sh"
do
  if [ -f "$BUILD_SCRIPT" ]; then
    bash "$BUILD_SCRIPT"
  fi
done
