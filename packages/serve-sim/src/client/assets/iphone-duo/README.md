# iPhone Duo model

The model is derived from Apple's **iPhone Duo, eSIM, Star White** USDZ:

https://www.apple.com/105/media/us/iphone-duo/2026/9305e4b9-72d9-4c05-9381-b572adadd5e5/ar/iPhone_Duo_e-sim_Star-White_Variant.usdz

Original model and textures are Apple assets. This conversion does not change their ownership or license. The source USDZ SHA-256 is `5cab2ea636da0bc0b06c8abf4809843498f7c1d680042b4f95e383b5c6a718b2` (8,107,136 bytes). `conversion.json` records the exact output dimensions and counts.

`model.glb.gz.txt` contains the complete GLB with embedded textures, losslessly gzip-compressed and encoded as base64 with a trailing newline. The client imports it so the CLI's embedded HTML works without a separate asset server or a request to Apple. The repository does not keep a duplicate uncompressed GLB.

## Conversion

From the repository root, with Python 3 and `usd-core`, `numpy`, and `Pillow` installed:

```sh
python scripts/convert-iphone-duo.py /path/to/iPhone_Duo_e-sim_Star-White_Variant.usdz packages/serve-sim/src/client/assets/iphone-duo
```

Add `--write-glb` to also produce an uncompressed `iphone-duo.glb` for local inspection. That optional file is ignored by git; the embedded payload is sufficient to reproduce it.

The conversion selects Apple's `Color=Star_White` and `Pose=Landscape` variants, bakes world transforms, preserves surface positions, normals, texture coordinates, materials and their textures, and makes these web rendering adjustments:

- Coordinates remain in centimeters. Subtract `(0, 5.8973725, 0.249478)` to center the display at the hinge origin. The inner display faces +Z, the hinge runs along Y, and the fully open device lies in XY.
- Split polygons crossing X=0 and interpolate their attributes to form `left-half` and `right-half`. This includes Apple's continuous inner screen and central hinge surfaces. Triangulate the source triangles/quads and deduplicate equivalent vertices. Both group pivots are `(0, 0, 0)`.
- Omit the source enclosing black box `lJPfQMFXvvcmdtA`, which extends several centimeters in front of and behind the device and is not a phone surface.
- Convert USD Preview Surface materials to glTF metallic/roughness materials. Pack metallic and roughness maps, combine opacity with base color, retain normal/occlusion/emissive maps and scalar clearcoat. Apple's RealityKit-specific shader graphs are represented by their USD Preview Surface equivalents. Emissive texture strength is normalized to 1 for the browser renderer.
- Resize texture images to a maximum of 1024 pixels per dimension, encode them as PNG, and flip texture V coordinates for glTF. No external textures are required.

The exported model has 81 meshes and 83,942 triangles. No source mesh simplification was applied.

## Articulation and display mapping

`iphone-duo` has two children, `left-half` and `right-half`. For an opening angle `a` in radians, rotate the left half around Y by `(PI - a) / 2` and the right half by its negative. At `a=PI` the model is flat; at `a=0` it is closed with its inner screens facing each other. Rotate the root for laptop/tent presentation.

The named `inner-display-left` and `inner-display-right` meshes retain full-display UVs: left samples U=0..0.5, right samples U=0.5..1. The inner display extends approximately X=-7.899354..7.899354, Y=-5.551748..5.551748, with Z=0 (submicrometer deviations from the source). Canvas/video textures should use `flipY=false` with the preserved glTF UVs. To replace them with planar UVs, map X over that complete range and map V downward from max Y.

`cover-display` belongs to `left-half` on its rear. Its original U coordinate runs toward negative X when viewed from the rear. Its source display texture is black. Its display bounds are approximately X=-7.973315..-0.233961, Y=-5.625643..5.625644, Z=-0.524106. Preserve its UVs for live cover-screen content.

`inner-bezel-left/right` and `hinge-left/right` are also named for optional presentation adjustments. Other mesh/material identifiers are retained from the original asset.
