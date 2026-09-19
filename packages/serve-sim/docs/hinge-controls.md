# Hinge controls and display selection

Foldable device position is a **hinge angle**. serve-sim uses degrees for its
controls and CLI:

| Control | CLI | Angle | UIKit status |
| --- | --- | --- | --- |
| Fold | `serve-sim hinge fold` | 0° | `closed` |
| Half Fold | `serve-sim hinge half` | 90° | `partiallyOpen` |
| Unfold | `serve-sim hinge unfold` | 180° | `fullyOpen` |

The CLI also accepts an angle, such as `serve-sim hinge 120 -d <udid>`. A command
waits for an acknowledgement and reports failures instead of assuming that
writing to the input socket changed the device.

## APIs inside an iOS app

The iOS 27.1 SDK provides `UIHinge`, `UIHinge.Status`, and `UIHingeInteraction`.
Attach an interaction to a view to receive the initial hinge state and later
updates. `update.hinge` can be nil when the view leaves a hierarchy that provides
hinge updates. `UIHinge.angle` is in **radians**; its status is `unknown`, `closed`,
`partiallyOpen`, or `fullyOpen`. The SDK recommends using status when only the
posture matters, because angle-update frequency and precision are system policy.

These are observation APIs for apps. They do not fold a physical device.

SwiftUI offers `onHingeChange`, whose closure receives the previous and current
hinge context. Apple calls this the **Hinge API**. Use hinge data for interactions
and effects; use scene geometry, arrangement, and region APIs for layout.

Source: `UIKit.framework/Headers/UIHinge.h` and `UIHingeInteraction.h` in the local
Xcode 27.1 beta iPhoneSimulator SDK, Apple's [UIHinge documentation](https://developer.apple.com/documentation/uikit/uihinge),
and [Leverage multiple displays and scenes on iPhone Duo](https://developer.apple.com/videos/play/tech-talks/111464/).

## DeviceHub's simulation control

DeviceHub's internal names are `closed`, `partiallyOpen`, and `openFlat`.
Its hinge slider sends a private CoreDevice vendor-defined HID event:

- Capability: `HIDVendorDefined.send(usagePage:usage:version:data:)`.
- Usage page `0xff61`, usage `0x5b`, version `0`.
- Data: `IOCFSerialize(dictionary, 1)` of the following dictionary:

```text
provider = com.apple.Virtualization.VirtualMachines
source = hinge-slider-control
type = range
value = angle in degrees, clamped to 0...180
```

This was verified against the booted iPhone Duo using CoreDevice's hinge-motion
readback. It is a private Xcode API and is separate from the public UIKit APIs.

DeviceHub's orientation picker uses the same transport with
`source = orientation-picker-control`, `type = enum`, and a value of `portrait`,
`pud`, `landscape-left`, or `landscape-right`. Duo ignores the legacy GSEvent
rotation path. The picker describes physical pose, so serve-sim converts the
requested screen orientation using the active panel's profile `nativeRotation`
(0° outside, 270° inside). Native display readback remains authoritative when an
app restricts rotation.

## Selecting the stream's display

The hinge angle alone is not a reliable substitute for the active display ID.
Display changes can arrive after the sensor angle changes. Both framebuffers
remain allocated, so choosing the largest surface can stream an inactive panel.
Legacy `SimScreenProperties.backlight` was also observed to retain stale values
after a fold. CoreDevice's display information supplies the authoritative active
display and orientation; capture and touch routing must follow the same display.

The closed screen uses DeviceKit's `phone15` frame. Half-folded and fully open
use the same `phone14` inner-display frame; there is no separate half-folded 2D
bezel in the installed assets. The frame and hardware buttons rotate around the
stream, whose touch coordinates remain aligned with its active screen. The
inner frame's button PDFs declare `/Rotate 270`; both asset dimensions and PNG
conversion must apply that page rotation.

In Xcode 27.1 beta, explicit touches to the inner display's digitizer can abort
`backboardd` with “Unable to dispatch event through disconnected service.” The
default digitizer alias also failed to deliver touches during testing. Until
that connection is resolved, foldable touch input is restricted to cover screen
1; inner streaming, hinge controls, and rotation remain available. Portrait and
both landscape directions were verified at 0°, 90°, and 180°. The test app
declined upside-down orientation, so that case is not counted as verified.

For independent checks on Xcode 27.1 beta:

```sh
xcrun devicectl device info displays --device <udid>
xcrun devicectl device motion hinge-angle --device <udid>
```

The motion command is a monitor. Its stdout can contain valid angle samples even
when a command timeout causes the final JSON report to record a timeout.
