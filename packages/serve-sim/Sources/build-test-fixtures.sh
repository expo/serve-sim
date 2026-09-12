#!/bin/bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"

# These fixtures arrive in separate PRs. Build every fixture present in the
# checkout so either PR can land first without changing the CI entry point.
for BUILD_SCRIPT in \
  "$HERE/ServeSimProbe/build.sh" \
  "$HERE/ServeSimLaunchFixture/build.sh" \
  "$HERE/SimNetProbe/build.sh"
do
  if [ -f "$BUILD_SCRIPT" ]; then
    bash "$BUILD_SCRIPT"
  fi
done
