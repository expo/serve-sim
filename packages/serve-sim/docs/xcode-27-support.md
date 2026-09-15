# Xcode 26 and 27 compatibility

Serve-sim supports the Simulator host in Xcode 26 and Device Hub in Xcode 27.
Selection follows `DEVELOPER_DIR` or `xcode-select`, so side-by-side Xcode
installations open the host that owns the active CoreSimulator runtime.

## Runtime selection

Xcode 27 moves the simulator host from
`Contents/Developer/Applications/Simulator.app` to
`Contents/Applications/DeviceHub.app`. Serve-sim resolves both locations inside
the selected Xcode and uses the matching launch mechanism:

- Device Hub: `devices://device/open?id=<UDID>`
- Simulator: `-CurrentDeviceUDID <UDID>`

The host launch is bounded and best-effort because headless machines may not
have a window server. Native framework loading normalizes `DEVELOPER_DIR`
whether it names `Xcode.app` or its `Contents/Developer` directory.

This matches the host-selection direction in
[EAS CLI #4405](https://github.com/expo/eas-cli/pull/4405),
[Expo CLI #46757](https://github.com/expo/expo/pull/46757), and
[Expo CLI #46809](https://github.com/expo/expo/pull/46809).

## Input transport

CoreSimulator 1155.4+ routes simulator input through the CoreDevice `dtuhidd`
service. Its legacy Indigo client can accept a send while the guest silently
drops it. Serve-sim detects
`com.apple.coredevice.feature.remote.hid.digitizer` at runtime and uses its XPC
transport for keyboard, touch, multi-touch, scroll touch events, and arbitrary
HID buttons. Older Xcodes retain the existing Indigo path.

The typing E2E checks the fixture's final `UITextField` value as well as native
send logs. This catches transport failures that occur after the native API
accepts an event.

## Capture reliability found during validation

Xcode 27's simulator timing exposed cross-version races in capture startup and
shutdown. The fixes:

- reuse the current environment snapshot and skip unchanged simulator writes;
- remove the injected loader before clearing its configuration;
- keep failed synchronous cleanup eligible for the exit-handler retry;
- bound follow-mode shutdown to the same 20-second budget as preview mode;
- retry the idempotent capture-ready announcement without retrying flow records;
- wait for the cold-launch fixture's complete app record before rebooting; and
- wait for the requested HAR entry to be flushed before asserting it.

These behaviors do not depend on an Xcode version.

## Local validation

The same branch passed all 1,278 tests across 161 files on both runtimes:

- Xcode 26.4 (17E192), iOS 26.4: zero failures in 399.33 seconds.
- Xcode 27 beta 6 (27A5252f), iOS 27: zero failures in 590.01 seconds.

The matrix includes live frames, WebRTC reconnect, screenshots, accessibility,
tap and exact text delivery, camera injection, simulator reboot recovery,
first-request capture, large POST/HAR capture, launch arguments, and deep links.
Three consecutive cold first-request capture runs also passed on Xcode 27.

The launch validation was local: Universe-generated steps downloaded, installed,
and started serve-sim on a real iOS Simulator, then checked one app start, launch
arguments, and the deep link. Loopback adapters replaced cloud tunnel and
reporting calls, and the local serve-sim build and device were pinned. This was
not a hosted EAS or API-to-worker E2E run.

## Follow-up opportunities

- Inspect Device Hub's watchOS and Home menu accessibility structure before
  replacing the Simulator-specific host actions.
- Verify streaming and input-coordinate mapping for Device Hub's separate
  Resizable display before exposing resize controls.
- Evaluate documented `devicectl` screenshot, recording, and device-management
  commands as validation or discrete-command fallbacks. They do not replace the
  low-latency live stream.
