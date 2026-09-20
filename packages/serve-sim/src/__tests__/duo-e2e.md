# Duo regression checks

Use a booted iPhone Duo with Xcode 27.1 and the locally built native addon.
These checks change only the selected local simulator. They do not replace an
existing preview process or exercise a hosted EAS/API-to-worker flow.

## Setup

From the repository root, build the addon while the local preview is stopped:

```sh
export DEVELOPER_DIR=/Applications/Xcode-27.1.0-Beta.app/Contents/Developer
export DUO_E2E_DEVICE=<booted-Duo-UDID>
bash packages/serve-sim/Sources/SimNative/build.sh packages/serve-sim/dist/native
TART_NO_AUTO_PRUNE=1 bun run packages/serve-sim/dev.ts
```

Select the Duo in the preview and press Start. In a second terminal, install
and launch the real UIKit fixture (same environment variables):

```sh
bash packages/serve-sim/src/__tests__/fixtures/duo/install.sh
```

The fixture changes a binary frame counter on both halves four times a second.
Separate tap counters and a shared drag counter expose actual simulator input.
Its bundle ID is `dev.expo.serve-sim.duo-fixture`.

## Browser motion, display, input, and controls

Open `http://localhost:3200/__dev/duo-e2e?device=<Duo-UDID>&unsupportedDevice=<regular-iPhone-UDID>` in the in-app browser
and press **Run Duo regressions**. Run **Run unsupported-device regression**
separately after restarting the preview so each real simulator owns its WebRTC
capture session for the duration of its check. The dev preview explicitly uses locked
WebRTC/H.264, matching the optimized product path. Acceptance fails unless all
three faces use one live WebRTC video track; HTTP fallback is not accepted.
Do not edit client code during a run; development auto-reload replaces the
preview document.

The runner first folds and reloads the iframe, waits for live cover counters,
and verifies there is no cached inner image. It then checks the first opening.
The sequence is Unfold → Half Fold → Fold → Unfold → Fold → Half Fold → Unfold,
followed by continuous angles and rapid reversal. Assertions cover:

- No whole-device Z rotation, size snap, or detached display during animation.
- Every visible physical face has content on every sampled animation frame;
  at least one face is visible throughout. Negative controls deliberately freeze
  and then black out a mounted right canvas to prove both oracles detect failure.
- Direct Fold↔Unfold keeps the right leaf flat, without a detour through Book.
- The cover stays visible while the first inner LCD warms up. Once a destination
  texture exists, repeat turns start within150ms. Cold readiness has a separate
  2s bound; the motion clock starts when the rigid body actually begins moving.
- Opening settles within 1–1.6s, travels right by 7–18% of spread width (reference
  ≈13%), and any native WebRTC opening effect clears without an added browser gradient.
  The spring fit uses right-edge measurements from go-duo.mov at 13.45–14.85s.
  Unlike the earlier 420ms cubic ease-out, the hinge follows measured motion.
  Raw WebRTC checkpoints prove that native frames already contain directional
  blur/shading: no synthetic screen gradient may double that effect.
  Half Fold → Unfold scales to its shorter travel.
- Each LCD keeps its own layout geometry during handoff; inactive faces retain
  their own image rather than being refitted using the other LCD dimensions.
- Native fixture pixels remain upright/readable and synchronized throughout
  Half Fold → Unfold (same LCD, sampled at animation frames). Transient native black buffers during the cover/inner LCD handoff must not
  replace visible retained textures. Native blur/shading may still appear in
  incoming frames; it must clear, and the fixture must resume advancing.
- Closed inner chrome is hidden, and the cover stream fills the actual
  DeviceKit cutout without stretching the cover into half the inner frame.
- After the closing leaf passes edge-on, the outer LCD remains black for every
  sampled moving frame and lights only after the native fold settles.
- No synthetic center line is rendered at Half Fold or Unfold. Half Fold gets
  its recessed hinge depth from the two perspective leaves and their edge
  shading. At 180°, leaf shadows and split 3D compositing are absent; one
  full-width inner surface preserves input on both halves.
- Interrupted transitions resume from the current pose; reduced-motion settings
  settle immediately.
- Constant physical device height across cover and spread; cover door rotates
  toward the viewer and retains its outward image until the back face hides.
- Half Fold outer edges project taller than the recessed spine. Device Hub's
  Book reference measures about 364px outside versus 348px at the spine (≈1.04).
- After bounded native handoff, both inner halves advance and display matching
  fixture counters. This reads real pixels, not callback or mounted-node counts.
- The cover advances after closing; real taps work on the cover and on both
  inner halves, including Half Fold perspective.
- Four controls, accessible continuous 0–180 slider, confirmed intermediate
  angles, last-request-wins reversal, Escape/focus restoration, and presets
  after slider use.
- Direct slider motion keeps the outer LCD visible on the moving cover through
  the early hinge range. The browser applies no CSS blur; any blur comes from
  the native WebRTC frames. The inner LCD remains visible as its leaf is
  revealed, and the settled 0° cover remains live.
- Direct slider geometry retains Device Hub's outer display through 54° and
  switches to the centered inner book at 55°, keeping equal projections
  afterward, including the 71° comparison point. Repeated 44°/45° input must
  neither flash black nor alternate visible faces.
- A negative control suppresses only the right projection canvas paint, verifies
  the freshness oracle fails, restores painting, then verifies synchronized updates.
  One shared WebRTC video decoder paints the three Duo canvases at display
  resolution; both inner canvases receive the same decoded frame synchronously.

The runner reports actual codec and fresh-panel readiness times. A retained,
readable image alone cannot satisfy readiness. Native handoff has an 8s bound;
input must update the fixture counter within 3s. These bounds are readiness
limits, not animation durations or promises of zero transport latency.

The **Inspect native opening frames** button captures the source video directly at
100–2200ms, independently of retained projection canvases, CSS chrome, or overlays. Use it when diagnosing shadow,
black-frame, blur, or LCD-handoff issues; it prevents mistaking a native effect
for a browser compositing effect.

Relaunch the fixture before browser
checks:

```sh
xcrun simctl launch "$DUO_E2E_DEVICE" dev.expo.serve-sim.duo-fixture
```

## Additional browser checks

Use real browser keyboard input on the Angle range: Home→0, ArrowRight→1,
End→180, ArrowLeft→179, Escape→closed with Angle focused. Drag from the left
inner half across the hinge to the right and verify the fixture DRAG counter
increases. These exercise browser pointer capture and native range keyboard
behavior beyond the in-page runner's synthesized events.

Reference: local `go-duo.mov` opening sequence and Device Hub Book. Automated
geometry/freshness checks do not establish pixel-perfect parity with every
reference frame, multitouch behavior, or touch accuracy at every screen corner.

## Presentation implementation

The two rigid leaf transforms interpolate directly between their rest poses.
`use-duo-presentation.ts` coordinates that motion with LCD readiness. The shared
WebRTC decoder holds outgoing and inactive projection canvases and uses a bounded
8×8 probe to reject temporary black destination frames during handoff. This is
not a transport fallback: there is still one peer, track, and video decoder.
Steady-state frames, including deliberately black apps, are not filtered.
The native hinge command sends the profile-mapped physical orientation directly;
it no longer waits1.5s for a visible surface before sending orientation. Removing
that wait did not eliminate the simulator's measured initial LCD warm-up.

Earlier local validation (September 19, 2026): 241/241 browser assertions, 46 focused
unit tests, typecheck, lint, and diff checks passed. The previous native build
passed 5 SimKVC and 7 FoldGeometry tests; this follow-up changed no native code.
Both sampled closing routes kept the outer LCD dark until completion, including
79/79 moving cover frames on the final run. All7 pose transitions had zero
unexpected black visible-face samples. Half Fold → Unfold reached midpoint in
295ms and settled in533ms while remaining upright, synchronized, and monotonic.
This is local real-simulator/WebRTC validation, not a hosted launch or CI run.


## Cover-edge and continuous-slider regressions

The cover's hinge gutter must occlude the underlying LCD throughout opening and
closing, not only at the fully folded endpoint. Three transformed probes sample
that gutter on every transition frame. The near-closed 6° case removes the solid
backing as a negative control, proving the oracle detects the original leak even
though a transparent layout container intercepts hit testing.

Range input uses direct presentation instead of restarting the preset spring.
A 14-sample sweep and reversal requires <1° error within 50ms of each input and
no black visible faces. The final full run measured 0° maximum error and zero
black samples. The decoder's painted-frame timestamp supplies retained-texture
readiness. Native LCD filtering continues for the normal settling interval after
geometry moves immediately, preventing late power-down frames from erasing it.
Preset buttons continue to animate; WebRTC remains the only transport.

Device Hub retains the outer LCD through 54° and changes to the symmetric inner
book at 55° in both directions. The physical geometry continues moving at every
degree; only display ownership changes at that boundary. Moving and settled
content, including at 22°, must have no
CSS blur so the native WebRTC effect is preserved without duplication.

`Run slider regressions` provides a shorter reproduction after warming both LCDs.
The full suite includes the same checks. Also verified real browser drags from
0° to 180° and back to 6°, ArrowLeft to 5°, Escape, and the Unfold preset. The
previously visible colored strip was absent in the near-closed screenshots.

## Captured Device Hub animation reference

Native Device Hub opening and closing were recorded locally and inspected as
frame contact sheets. Both cover crossings settle in about 1.0–1.1s. Opening
keeps the outer LCD lit until edge-on, crosses a short dark LCD phase, then
reveals a blurred inner LCD that resolves while the device finishes opening.
Closing keeps the inner LCD visible until edge-on, crosses the dark phase, then
reveals a blurred outer LCD that resolves at the folded endpoint.

The browser implements the dark phase independently from decoded WebRTC frame
freshness. It does not add a blur overlay; native WebRTC pixels provide that
effect. The shared WebRTC canvases must remain decoded and visible throughout. This
prevents transport black frames from being mistaken for the intentional LCD
effect and prevents canceled rapid reversals from committing stale display
ownership.

Final local validation: the full real-Simulator WebRTC suite passed 284 browser
assertions and the shorter slider suite passed every check. The 56 focused unit
tests passed with 382 assertions; typecheck, lint, and diff checks also passed.
The opening settled
in 963–982ms with 10.3–10.4% rightward translation. Closing crossed edge-on in
479–570ms and settled in 1077–1098ms. Both directions exercised the dark LCD
phase with no CSS blur, zero decoded black-face samples, synchronized inner frames, real
input, motion interruption, reduced motion, and the 55°/54° slider
handoff.

The direct outer-display pose remains a mostly frontal single device through
54°, matching Device Hub instead of rotating toward an edge-on sliver. The
55° boundary changes to the symmetric inner book and 54° returns to the frontal
outer device. Browser
coverage verifies the single-device silhouette at 45°, 51°, and 54°. It also
requires the angle panel to open entirely below the fold-control bar.

Intermediate slider targets use the interruptible motion timeline instead of
teleporting the 3D pose. Unfold → 53° and 53° → 44° are sampled after 50ms to
prove they are still moving toward their targets. At 53° the native cover
framebuffer and browser cover face agree, so a portrait cover frame is never
split across the inner leaves. The leaves overlap by 0.5px at the hinge and use
no leaf-shadow filter; the supporting leaf remains visible through the narrow
edge-on handoff so there is no raster seam or empty frame.
