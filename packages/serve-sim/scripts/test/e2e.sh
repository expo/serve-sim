#!/usr/bin/env bash
# The simulator-backed run: `bun run test:e2e`.
#
# Requires SERVE_SIM_TEST_UDID, the simulator you booted for this run, so the
# tests never pick a device that belongs to another session. Builds the test
# fixtures the launch suites need, then sets SERVE_SIM_E2E_REQUIRED=1 so a
# missing precondition fails instead of skipping.
#
# Pass test paths to narrow the run; with none it runs the whole Bun suite.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../../.." && pwd)"

: "${SERVE_SIM_TEST_UDID:?Set SERVE_SIM_TEST_UDID to the UDID of a simulator you booted for this run. \`xcrun simctl list devices booted\` lists them.}"
if ! xcrun simctl list devices booted -j | grep -q "\"udid\" : \"$SERVE_SIM_TEST_UDID\""; then
  echo "serve-sim test:e2e: $SERVE_SIM_TEST_UDID is not a booted simulator. Boot it with \`xcrun simctl boot $SERVE_SIM_TEST_UDID\`." >&2
  exit 1
fi

bash "$ROOT/packages/serve-sim/Sources/build-test-fixtures.sh" >/dev/null
export SERVE_SIM_E2E_REQUIRED=1

cd "$ROOT"
if [ $# -eq 0 ]; then
  set -- packages/serve-sim/src/__tests__/ packages/serve-sim/scripts/tart/__tests__/
fi
exec bun test --max-concurrency=1 "$@"
