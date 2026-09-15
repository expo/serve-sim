# Xcode 27 and Device Hub opportunities

Research checked September 15, 2026. This note describes upstream evidence,
inspection and focused runtime experiments on Xcode 27 beta 6. Capture and
accessibility work in the smoke test; legacy touch delivery remains broken. Final-release documentation may
describe fixes newer than the inspected beta.

## Compatibility first

[EAS CLI #4405](https://github.com/expo/eas-cli/pull/4405), merged September 15,
adds Device Hub discovery, process recognition, bundle-ID validation, and launch
fallback for simulator builds. Its diff retains `simctl` for simulator operations.
The Device Hub bundle is `Contents/Applications/DeviceHub.app`, outside
`Contents/Developer`; its identifier is `com.apple.dt.Devices`.

[Expo #46757](https://github.com/expo/expo/pull/46757) added initial compatibility.
[Expo #46809](https://github.com/expo/expo/pull/46809), merged June 11, subsequently
added `devices://device/open?id=<UDID>` to select a particular device. The earlier
PR's statement that selecting a device is impossible is therefore obsolete.

**Our implementation conclusion:** resolve the app inside the selected Xcode and
explicitly target that app when opening the URL. Name-based Launch Services
fallback can select a different installation when Xcode 26 and 27 coexist. Keep
the existing native capture/input backend until runtime checks establish which
private interfaces changed; these Expo PRs do not validate those interfaces.

## Verified additions and limits

Apple's [Xcode 27 release notes](https://developer.apple.com/documentation/xcode-release-notes/xcode-27-release-notes)
confirm:

- Agent tools can boot simulators, install/launch apps, synthesize touch, and take
  screenshots (175179787).
- Device Hub supports pointer scroll/transform events; clicks simulate direct
  finger touches. Trackpad pinch is not evidence of two-finger touch support:
  two-finger touch remains unsupported (169537162).
- Shake remains broken in Device Hub (171282777). Keyboard/pointer input requires
  iOS 18, tvOS 18, watchOS 11, or visionOS 2 and later.
- `devicectl` supports JSON on stdout. JSON v5 deprecates
  `hardwareProperties`, `deviceProperties`, and `connectionProperties` in favor
  of `properties`; parse JSON rather than the changing text identifier column.
- Final Xcode 27 requires macOS 26.6+. Resize mode requires an app linked against
  the iOS 27 SDK. Check the actual beta's requirements separately.

Apple's [configuration documentation](https://developer.apple.com/documentation/xcode/configuring-the-environment-of-a-simulated-device)
describes resizing an iPhone's simulated screen using handles or numeric
dimensions. This changes the app's available screen size; ordinary canvas zoom
only changes presentation. Device Hub also exposes appearance, Liquid Glass,
text size, audio, location, and orientation settings.

Apple's [Device Hub session](https://developer.apple.com/videos/play/wwdc2026/260/)
demonstrates downloading/restoring app data, collecting diagnostics, and matching
a physical device's configuration in a simulator. It recommends `devicectl` for
scripted device management and settings. It does not establish that every GUI
operation has a public command or that all commands support simulators.

## Experiments, in priority order

1. **P0 — Preserve the working simulator pipeline.** On both Xcodes, validate
   selected host app, one app launch with arguments and a deep link, advancing
   video frames, tap/drag/text/buttons, rotation, accessibility output, and camera
   injection. On 27, repeat while Device Hub is closed, compact, expanded, and
   focused on another device. Compare loaded framework paths and missing symbols
   with the 26 baseline. A successful `dlopen` alone does not prove ABI safety.
2. **P1 — Inspect official automation.** In the VM, inspect `xcrun devicectl help`
   and its advertised subcommands, and enumerate Xcode's MCP tools through its
   configured bridge. Save actual schemas before invoking them. Try one supported
   screenshot and touch action against the same simulator. Measure setup needs,
   latency, coordinates, and error reporting. These could provide validation or a
   discrete-command fallback; screenshots do not replace live video streaming.
3. **P1 — Verify serve-sim's useful differences.** Test genuine simultaneous
   two-finger input and shake with a small event-reporting app. Check older
   simulator runtimes if installed. Preserve native operations that work beyond
   Device Hub's current limitations; do not assume they work without observation.
4. **P2 — Resizing and repeatable UI checks.** First resize manually in Device
   Hub using an iOS 27-linked app. Verify frame dimensions, encoder recovery,
   normalized input mapping, and accessibility coordinates before/after resizing,
   backgrounding, and rotation. Discover a callable control before offering a
   serve-sim resize command. Combine proven settings with named reproduction
   presets and screenshot capture; most appearance controls already exist here.
5. **P2 — Reproduction packages.** Explore exporting app data plus runtime,
   device type, orientation, location, appearance, text size, screenshot, and
   launch URL. Restore on a disposable simulator and verify the same state.
   Treat app data as explicitly selected content, not an automatic upload.

## Physical-device direction

Device Hub's screen interaction makes a future physical-device backend worth
investigating for real hardware behavior. However, Apple's
[interaction documentation](https://developer.apple.com/documentation/xcode/interacting-with-your-app-in-device-hub)
explicitly describes camera/microphone conflicts while viewing a physical device:
some apps can record silence/empty video, and higher-priority apps such as
Phone/FaceTime stop the interaction. This is a material constraint for Expo camera
testing, not a substitute for serve-sim's simulator camera injection.

**Inference, not a supported integration:** start a physical-device experiment
with documented discovery/install/launch/diagnostic commands. Treat remote display
and input as separate capabilities. A mirrored screen in Apple's app does not
establish a public reusable streaming API. No physical-device runtime validation
was performed for this note; a simulator-only Tart VM cannot establish it.

## Private API boundary

The existing native backend uses SimulatorKit/CoreSimulator selectors, Indigo
HID messages, IOSurface callbacks, and an accessibility translation bridge.
These are private contracts. New Device Hub frameworks, exported symbols, or
protocol names are research leads, not evidence that an unsigned third-party
helper has the required entitlement or that an ABI is stable. Keep any new
backend behind capability detection and verify actual frame/input behavior on
each supported Xcode before making it the default.

## Observed in the Xcode 27 beta 6 VM

Read-only inspection used Xcode 27.0 build 27A5252f on macOS 26.6.2 (25G83).
The same metadata probe also ran on Xcode 26.4 build 17E192. All five Indigo
exports and four explicitly named private classes used by the inspected native
paths were present in both versions. SimulatorKit moved to
`Contents/SharedFrameworks` as expected. The HID client's send-method encoding
changed inside its extended-event payload from `{?=I[64c]}` to `{?=IC[64c]}`;
the method argument offsets and touch-event encoding did not change. Passing
framework-created opaque messages may avoid dependence on that inner layout,
but this requires an input test rather than an ABI-compatibility claim.

The three framebuffer callback/surface selectors were absent from the inspected
class metadata on both versions. This is inconclusive: descriptor classes can
load lazily. No private objects were constructed or methods invoked by the probe.

The VM's own command help advertises concrete official interfaces:

```sh
# Start persists until interrupted; exiting ends the session.
xcrun devicectl device appResize start --device DEVICE --preferred-size 800x600
# Adjust from another process while the session remains active.
xcrun devicectl device appResize set --device DEVICE --preferred-size 600x800
xcrun devicectl device capture screenshot --device DEVICE --destination /tmp/screen.png
xcrun devicectl device capture screen-record --device DEVICE --destination /tmp/screen.mp4 --duration 5 --codec h264
```

Resize targets a display whose name contains `Resizable`. Capture commands also
accept `--display-unique-id`, with IDs discoverable through `device info displays`.
Recording accepts H.264/HEVC and bezel mask policies. The accompanying runtime
validation successfully ran the screenshot command against the simulator UDID
and produced a 1206 × 2622 PNG, confirming simulator support for that command.
A scene-based fixture linked with the iOS 27 SDK successfully entered an
800×600-point resize session. The command created a separate virtual Resizable
display; targeted capture produced a 2400×1800 PNG, and the app displayed the
expected 800×600-point bounds. A later set command ran after the bounded start
session expired and correctly failed because no resize session was active;
live resizing and serve-sim streaming of that display still need validation.
Recording has not been exercised.

`xcrun mcpbridge --help` describes a JSON-RPC STDIO bridge to an Xcode process,
selected by the active Xcode or `MCP_XCODE_PID`. Its help does not expose touch
tool schemas. Exact MCP touch schemas remain unverified without connecting to
the running Xcode service.


Runtime input investigation found no app-observed tap despite successful legacy
HID send completions, longer presses, and foregrounding Device Hub. The Indigo
touch constructor and legacy initialization disassembly did not expose an ABI
change that explains this. Device Hub symbols instead reference DeviceKit and
CoreDevice HID service registration with UniversalHID digitizer reports. These
are leads for the next input experiment, not a verified replacement API.
