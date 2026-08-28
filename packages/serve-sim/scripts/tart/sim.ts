import type { TartGuest } from "./guest";

const GUEST_PATH = 'export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"';

const BOOT_SIM = `${GUEST_PATH}
set -euo pipefail
if xcrun simctl list devices booted | grep -q Booted; then
  exit 0
fi
UDID="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
data = json.load(sys.stdin)
for runtime, devices in data.get("devices", {}).items():
    if "iOS" not in runtime:
        continue
    for device in devices:
        if device.get("name") == "iPhone 17" and device.get("isAvailable"):
            print(device["udid"])
            raise SystemExit
raise SystemExit("no available iPhone 17")
')"
echo "booting $UDID"
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b
`;

export async function bootSim(guest: TartGuest): Promise<void> {
  const code = await guest.sshInherit(BOOT_SIM);
  if (code !== 0) throw new Error("failed to boot an iPhone 17 on the guest");
}

// First app launch after boot with DYLD_INSERT_LIBRARIES set is denied by
// SpringBoard. Same shape as EAS: launch a system app with insert cleared.
const WARM_SAFARI = `${GUEST_PATH}
set -euo pipefail
UDID="$(xcrun simctl list devices booted -j | python3 -c '
import json, sys
data = json.load(sys.stdin)
for devices in data.get("devices", {}).values():
    for device in devices:
        if device.get("state") == "Booted" and "iPhone" in device.get("name", ""):
            print(device["udid"])
            raise SystemExit
raise SystemExit("no booted iPhone")
')"
env SIMCTL_CHILD_DYLD_INSERT_LIBRARIES= xcrun simctl spawn "$UDID" launchctl unsetenv DYLD_INSERT_LIBRARIES >/dev/null 2>&1 || true
xcrun simctl launch "$UDID" com.apple.mobilesafari >/dev/null
`;

export async function warmSafari(guest: TartGuest): Promise<void> {
  const code = await guest.sshInherit(WARM_SAFARI);
  if (code !== 0) throw new Error("failed to warm Safari on the guest");
}
