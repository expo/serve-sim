# iPhone Duo 3D model

The interactive device preview uses Apple's official **iPhone Duo, eSIM, Star White** AR model:

<https://www.apple.com/105/media/us/iphone-duo/2026/9305e4b9-72d9-4c05-9381-b572adadd5e5/ar/iPhone_Duo_e-sim_Star-White_Variant.usdz>

The original model is © Apple Inc. See `NOTICE`. This is a conversion of that asset, including its chassis, bezels, cameras, ports, buttons, and display outlines.

Source SHA-256: `5cab2ea636da0bc0b06c8abf4809843498f7c1d680042b4f95e383b5c6a718b2`.

## Regeneration

Use an isolated Python environment with `usd-core`, `numpy`, and `Pillow`. The checked-in asset was generated with Python 3.12, usd-core 26.8, NumPy 2.5.3, and Pillow 12.3.0. The converter verifies the source SHA-256 before applying model-specific articulation changes:

```sh
python3 -m venv /tmp/serve-sim-duo-model-env
/tmp/serve-sim-duo-model-env/bin/pip install usd-core numpy pillow
/tmp/serve-sim-duo-model-env/bin/python packages/serve-sim/scripts/convert-iphone-duo-model.py
```

Pass `--source /path/to/downloaded.usdz` to reuse a download. The script writes `src/client/assets/iphone-duo-model.glb.base64`. This text representation is decoded by the server and served as a binary GLB at `/assets/iphone-duo/model.glb`. No model or texture request goes to Apple at runtime.

The conversion uses the USD scene transforms and material bindings, triangulates polygons, deduplicates vertices, converts standard surface materials, and embeds image textures. Normals use normalized 16-bit values with `KHR_mesh_quantization`; UVs use normalized unsigned 16-bit values. Positions remain float32. Color textures are capped at 1024 pixels, with JPEG compression for larger opaque images. Scalar roughness and metalness texture maps are averaged into material factors; RealityKit-only shading is omitted.

## Articulation contract

The source model is closed. The conversion opens and recenters the two original chassis assemblies around a vertical hinge, then gives them stable names. Units are centimeters; X is horizontal, Y is up, and the inner display faces +Z. The default pose is fully open (180°).

| Node | Purpose |
| --- | --- |
| `iphone-duo` | Root |
| `duo-left` | Cover display chassis; pivot at the origin |
| `duo-right` | Rear camera chassis; pivot at the origin |
| `duo-hinge` | Recessed hinge barrel |
| `duo-screen-left` | Inner display, U 0–0.5 |
| `duo-screen-right` | Inner display, U 0.5–1 |
| `duo-screen-cover` | Outer display, U 0–1 |

For angle θ, rotate the left half around Y by +(180−θ)/2 degrees and the right half by −(180−θ)/2 degrees. Device orientation is applied to the parent root to produce Book, Laptop, and Tent poses.

The inner display is approximately 15.775 × 11.104 cm and sits at Z = −0.025 cm. Its authored continuous UVs are used to flatten the closed flexible display into two articulated surfaces while preserving Apple's rounded outline and cutouts. The two chassis halves are approximately 8.23 × 11.82 cm. The closed model's barrel is recessed behind the open screen; the invisible RealityKit collision mesh is omitted. These are deliberate adjustments for a continuously animated simulator preview.

UV V is 0 at the top, as in glTF. Live canvas/video textures should use `flipY = false`. Replacing the three screen materials with live simulator textures leaves Apple's hardware geometry intact. Each converted mesh stores its original USD prim path in `extras.sourcePrim` for inspection.

## Preview behavior

The renderer keeps the transport and WebGL scene mounted while folding. Each display has its own retained canvas texture, so the last decoded image stays on an inactive panel during a transition. New frames update only the active display. During display handoffs, mismatched frame sizes and transient blank IOSurfaces retain the previous image until suitable pixels arrive. The native inner display uses a portrait pixel buffer that needs a clockwise quarter-turn to match the unfolded model's landscape UVs; the cover uses its native portrait orientation. This mapping is independent of the app's reported orientation.

Hinge and chassis rotations use critically damped, elapsed-time springs. A new angle or pose updates the target of the running animation, preserving its current position and velocity. Fine angle changes retain the last physical pose; explicit toolbar rotation is tracked separately. The animation honors `prefers-reduced-motion` by applying targets immediately.

Raycasts through the displayed screen convert touches back to native stream coordinates. Drag, two-finger touch, Alt-drag pinch, Alt+Shift-drag pan, scroll, and the app-oriented home-indicator edge remain interactive. Wheel input uses the projected screen axes, including the perspective of each folding half.

The frame display option controls the 3D chassis. Turning the frame off, opening accessibility inspection, or losing WebGL/model support returns to the flat simulator view. Connection and stream errors remain visible outside the hidden transport surface. GPU resources, pointer gestures, animation frames, and resize observers are released when the 3D view unmounts.
