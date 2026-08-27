#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "Usage: $0 <@expo/serve-sim-version>" >&2
  exit 1
fi

SERVE_SIM_VERSION="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTIFACT_DIR="${SERVE_SIM_SYSTEM_TEST_ARTIFACTS:-$SCRIPT_DIR/artifacts}"
EAS_ACCOUNT="${EAS_SIMULATOR_ACCOUNT:-expo-services}"
EAS=(npx --yes eas-cli@latest)
SESSION_ACTIVE=false

mkdir -p "$ARTIFACT_DIR"
cd "$SCRIPT_DIR"

reset_session_env() {
  printf '# managed by eas-cli\n' > .env.eas-simulator
}

stop_active_session() {
  if [[ "$SESSION_ACTIVE" == "true" ]]; then
    "${EAS[@]}" simulator:stop --non-interactive
    SESSION_ACTIVE=false
  fi
  reset_session_env
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$SESSION_ACTIVE" == "true" ]]; then
    "${EAS[@]}" simulator:stop --non-interactive || true
  fi
  reset_session_env
  exit "$status"
}
trap cleanup EXIT INT TERM

assert_session_and_preview() {
  local controller="$1"
  local session_json preview_url preview_html
  session_json="$(mktemp)"
  preview_html="$(mktemp)"

  "${EAS[@]}" simulator:get --json --non-interactive > "$session_json"
  preview_url="$(node - "$session_json" "$controller" <<'NODE'
const fs = require("node:fs");
const [file, expectedType] = process.argv.slice(2);
const session = JSON.parse(fs.readFileSync(file, "utf8"));
if (session.status !== "IN_PROGRESS") {
  throw new Error(`Expected an IN_PROGRESS session, received ${session.status}`);
}
if (session.type !== expectedType) {
  throw new Error(`Expected a ${expectedType} session, received ${session.type}`);
}
const previewUrl = session.remoteConfig?.webPreviewUrl;
if (typeof previewUrl !== "string" || previewUrl.length === 0) {
  throw new Error(`${expectedType} session did not expose a serve-sim web preview`);
}
process.stdout.write(previewUrl);
NODE
)"

  curl --fail --silent --show-error \
    --retry 10 --retry-delay 3 --retry-all-errors --max-time 20 \
    "$preview_url" > "$preview_html"
  grep -Fq '<title>Simulator Preview</title>' "$preview_html"
  rm -f "$session_json" "$preview_html"
}

start_session() {
  local controller="$1"
  local name="$2"
  reset_session_env
  SESSION_ACTIVE=true
  "${EAS[@]}" simulator:start \
    --platform ios \
    --type "$controller" \
    --package-version "$SERVE_SIM_VERSION" \
    --max-duration-minutes 20 \
    --name "$name" \
    --non-interactive
  assert_session_and_preview "$controller"
}

run_agent_device_test() {
  start_session "agent-device" "serve-sim next agent-device gate"

  "${EAS[@]}" simulator:exec npx --yes agent-device@latest apps --all --platform ios \
    > "$ARTIFACT_DIR/agent-device-apps.txt"
  "${EAS[@]}" simulator:exec npx --yes agent-device@latest open com.apple.Preferences --foreground --platform ios
  "${EAS[@]}" simulator:exec npx --yes agent-device@latest snapshot -i --platform ios \
    > "$ARTIFACT_DIR/agent-device-snapshot.txt"
  "${EAS[@]}" simulator:exec npx --yes agent-device@latest press 'label="General"' --verify --platform ios
  "${EAS[@]}" simulator:exec npx --yes agent-device@latest screenshot \
    "$ARTIFACT_DIR/agent-device.png" --normalize-status-bar --platform ios

  test -s "$ARTIFACT_DIR/agent-device-snapshot.txt"
  test -s "$ARTIFACT_DIR/agent-device.png"
  stop_active_session
}

run_argent_test() {
  local devices_json udid
  start_session "argent" "serve-sim next argent gate"

  # Argent is invoked directly with the connection environment. Routing it
  # through simulator:exec can strip flags from `argent run` commands.
  set -a
  # shellcheck disable=SC1091
  source .env.eas-simulator
  set +a

  devices_json="$ARTIFACT_DIR/argent-devices.json"
  npx --yes @swmansion/argent@latest run list-devices --json > "$devices_json"
  udid="$(node - "$devices_json" <<'NODE'
const fs = require("node:fs");
const result = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const device = result.devices?.find(
  candidate =>
    (candidate.platform === "ios" || candidate.platform === "ios-remote") &&
    candidate.state === "Booted",
);
if (!device?.udid) throw new Error("Argent did not report a booted iOS simulator");
process.stdout.write(device.udid);
NODE
)"

  npx --yes @swmansion/argent@latest run launch-app \
    --udid "$udid" --bundleId com.apple.Preferences --json
  npx --yes @swmansion/argent@latest run describe \
    --udid "$udid" --json > "$ARTIFACT_DIR/argent-describe.json"
  npx --yes @swmansion/argent@latest run gesture-tap \
    --udid "$udid" --x 0.5 --y 0.5 --json
  npx --yes @swmansion/argent@latest run screenshot \
    --udid "$udid" --scale 1 --includeImageInContext false \
    --out "$ARTIFACT_DIR/argent.png"

  test -s "$ARTIFACT_DIR/argent-describe.json"
  test -s "$ARTIFACT_DIR/argent.png"
  stop_active_session
}

"${EAS[@]}" whoami
configured_owner="$(node -p "require('./app.json').expo.owner")"
if [[ "$configured_owner" != "$EAS_ACCOUNT" ]]; then
  echo "Expected EAS project owner $EAS_ACCOUNT, received $configured_owner" >&2
  exit 1
fi
"${EAS[@]}" init --account "$EAS_ACCOUNT" --force --non-interactive

availability_json="$("${EAS[@]}" simulator:availability --json --non-interactive)"
node -e '
  const availability = JSON.parse(process.argv[1]);
  if (availability.available !== true) {
    throw new Error(`EAS Simulator is unavailable for ${availability.accountName ?? "this account"}`);
  }
' "$availability_json"

run_agent_device_test
run_argent_test
