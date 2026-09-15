# Xcode 26 and 27 compatibility

## Evidence

- [EAS CLI #4405](https://github.com/expo/eas-cli/pull/4405) adds Device Hub discovery,
  process detection, and device URL launching. Its author reports manual runs on
  Xcode 27.0 and 26.6. This is upstream evidence, not serve-sim validation.
- [Expo CLI #46757](https://github.com/expo/expo/pull/46757) introduces Device Hub
  support; [#46809](https://github.com/expo/expo/pull/46809) adds device focusing
  through `devices://device/open?id=<UDID>`.
- The host app moves from `Contents/Developer/Applications/Simulator.app` to
  `Contents/Applications/DeviceHub.app` (bundle ID `com.apple.dt.Devices`).
- Serve-sim already probes both SimulatorKit locations:
  `Contents/Developer/Library/PrivateFrameworks` and `Contents/SharedFrameworks`.
  CoreSimulator and SimulatorKit are loaded dynamically, without a link-time
  dependency on either Xcode layout.

## Implementation plan

1. Resolve the host inside the selected Xcode instead of through a global app
   name. Prefer Device Hub when present, otherwise Simulator. Honor
   `DEVELOPER_DIR` through `xcode-select -p`, including an app-bundle override.
2. Open that exact app in the background. Use the Device Hub URL to select a
   device, or Simulator's `-CurrentDeviceUDID` argument. Keep launch attempts
   bounded and best-effort for headless hosts; expose failures in debug logs.
3. Normalize the native developer directory consistently, so framework loading
   and `SimServiceContext` do not accidentally use an app bundle as a Developer
   directory. Cover both host layouts and native path normalization in tests.
4. Rebuild the local CLI and validate on the installed Xcode 26.4.
5. Validate the same build with Xcode 27 in a Tart VM, using explicit
   `DEVELOPER_DIR` values. Do not call support complete until this matrix passes.

Steps 1–5 are complete on this branch. Validation results are recorded below.

## Runtime validation matrix

For each Xcode installation, run the rebuilt local CLI with that installation's
`DEVELOPER_DIR`. Start from a stopped host app, select a simulator, and verify:

- Correct host opens; the requested device supplies live frames and screenshots.
- Tap, drag, keyboard input, Home, rotation, and accessibility dumps work.
- App install/start and a deep link succeed without a duplicate app launch.
- Camera injection works on the selected runtime.
- WebRTC reconnect and simulator shutdown/reboot recover.
- Switching Xcode works after restarting serve-sim (native frameworks stay loaded
  for the life of the process).

The local Xcode 26.4 host and Xcode 27 beta 6 Tart VM passed this matrix. Audit
these remaining Device Hub-specific integrations on a real interactive Xcode 27
host:

- `host-actions.ts` uses Simulator's watchOS window and Device > Home menu.
  Device Hub's accessibility/menu structure must be inspected before adapting it.
- `middleware.ts` uses Simulator's `CurrentDeviceUDID` preference as an optional
  sorting hint. Device Hub's equivalent is unverified; this does not select the
  streamed device.

## Focused test commands

From the repository root:

```sh
bun test packages/serve-sim/src/__tests__/simulator-host.test.ts
swiftc packages/serve-sim/Sources/SimNative/Xcode.swift \
  packages/serve-sim/Tests/XcodeTests/main.swift -o /tmp/serve-sim-xcode-tests
/tmp/serve-sim-xcode-tests
bun run typecheck
bun run lint
bun run packages/serve-sim/build.ts
```

## Local validation

- Xcode 26.4 (17E192), iOS 26.4, iPhone 17 Pro: native build passed;
  rebuilt Node CLI started with `DEVELOPER_DIR=/Applications/Xcode.app` and an
  isolated state directory. Host launch, health, live JPEG capture (1206×2622),
  native Home input, and a populated accessibility tree passed. A disposable
  fixture additionally confirmed changing frames, taps, exact typed text, one
  app launch, launch arguments, and deep-link delivery. App install/launch used
  simctl; input and frame capture used the rebuilt serve-sim. This is a local
  smoke test, not a hosted EAS/API-to-worker end-to-end run.
- The self-contained binary passed the same fixture in normal preview mode on
  26.4. Its separate `--no-preview` re-execution path failed with
  `Module not found "/$bunfs/root/serve-sim"`; that path is unchanged by this
  patch. The VM comparison uses normal preview mode.
- 11 TypeScript host-selection/launch tests and 6 standalone Swift path checks
  passed. Typecheck, lint, and whitespace checks passed. Native build emitted
  NodeAPI macro concurrency warnings in unchanged code.
- Xcode 27 beta 6 (27A5252f), iOS 27 (24A5423a), macOS 26.6.2:
  the same Xcode 26-built binary opens Device Hub, starts successfully, captures
  live 1206×2622 frames, and returns a populated accessibility tree. The fixture
  installs and launches. CoreSimulator 1155.4+ suppresses legacy Indigo keyboard
  delivery even though the old client reports successful sends. Serve-sim now
  discovers the `dtuhidd` CoreDevice service at runtime and uses it for keyboard,
  touch, multi-touch, scroll, and arbitrary HID buttons when available. The same
  app-observed fixture records exact typed text and button taps on both Xcode
  versions. Home continues to use the existing simctl SpringBoard fallback.
- The VM is `serve-sim-xcode27` (initially 4 CPUs, now 8 CPUs, 12 GB memory), cloned from
  `ghcr.io/cirruslabs/macos-tahoe-xcode:27-beta-6`, pinned to digest
  `sha256:f441eb487a18b4588c096adcff5eb48fddca550909e01c472580872b48c166b0`.
  Gabe authorized stopping `tahoe-xcode` to free a VM slot;
  `turtle-worker-serve-sim` was left running.
- Official `devicectl` screenshot capture succeeds on this simulator. A disposable
  scene-based app compiled with the iOS 27 SDK also enters an 800×600-point
  appResize session. Capture of its separate Resizable display produces a
  2400×1800 PNG showing the expected layout. This is a tooling experiment;
  serve-sim display selection and input mapping for that display remain untested.

## Capture PR and input validation

The capture PR #157 tip was validated with this compatibility work. The final
runs pass all 1,278 tests on each Xcode with zero failures or skips: 399.33
seconds on Xcode 26.4 and 590.01 seconds on Xcode 27 beta 6. Three consecutive
real cold capture launches also pass on Xcode 27 after fixing a fixture
installation race. See
[xcode-27-failure-investigation.md](xcode-27-failure-investigation.md) for root
causes, minimal fixes, and final results.

An identical app-observed input probe in Tart separated the transport change
from virtualization: Xcode 26.4 delivered `a` through legacy Indigo, while Xcode
27 beta 6 accepted the same message but dropped it. Sending `a` through the
CoreDevice `dtuhidd` service produced its barrier reply and updated the field.
The production runtime-selected transport then passed the same typing and tap
checks. The typing E2E now asserts the fixture's UITextField value in addition
to native send logs. Device Hub's watchOS menu integration and serving its
separate Resizable display remain separate work.

Validation artifacts and disposable fixture sources are currently under
`/private/tmp/serve-sim-xcode27-validation`, with VM evidence in `vm27/`.
