#!/usr/bin/env python3
"""Convert Apple's closed iPhone Duo USDZ to an articulated, self-contained GLB.

Requires Python 3.12+, usd-core, numpy, and Pillow. See docs/iphone-duo-model.md.
"""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import struct
import tempfile
import urllib.request
import zipfile

import numpy as np
from PIL import Image
from pxr import Usd, UsdGeom, UsdShade

SOURCE = 'https://www.apple.com/105/media/us/iphone-duo/2026/9305e4b9-72d9-4c05-9381-b572adadd5e5/ar/iPhone_Duo_e-sim_Star-White_Variant.usdz'
SOURCE_SHA256 = '5cab2ea636da0bc0b06c8abf4809843498f7c1d680042b4f95e383b5c6a718b2'
HINGE_X = -4.09595108
CENTER_Y = 5.897372
INNER_HALF_WIDTH = 7.8874698
GROUP_COVER = 'upTUAKvMVkPOMKq'
GROUP_BACK = 'SiftyleUEEZwLhF'
INNER_SCREEN = 'UXtsBZYlaUvHoEh'
COVER_SCREEN = 'hhgAIoCGsHXeDPY'
HINGE = 'MvKPXGSdYDVvSpk'
COLLISION = 'lJPfQMFXvvcmdtA'


def convert(source, output):
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if source_hash != SOURCE_SHA256:
        raise ValueError('USDZ differs from the documented Apple source; inspect its geometry before updating this converter.')
    stage = Usd.Stage.Open(str(source))
    transform_cache = UsdGeom.XformCache()
    archive = zipfile.ZipFile(source)
    archive_names = {Path(name).name: name for name in archive.namelist()}
    binary = bytearray()
    gltf = {
        'asset': {'version': '2.0', 'generator': 'serve-sim Apple USDZ conversion', 'copyright': 'Original model © Apple Inc.'},
        'scene': 0, 'scenes': [{'nodes': [0]}],
        'extensionsUsed': ['KHR_mesh_quantization'], 'extensionsRequired': ['KHR_mesh_quantization'],
        'nodes': [
            {'name': 'iphone-duo', 'children': [1, 2, 3], 'extras': {'source': SOURCE, 'units': 'centimeters', 'openAngle': 180}},
            {'name': 'duo-left', 'children': []},
            {'name': 'duo-right', 'children': []},
            {'name': 'duo-hinge', 'children': []},
        ],
        'meshes': [], 'materials': [], 'accessors': [], 'bufferViews': [],
        'images': [], 'textures': [], 'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 33071, 'wrapT': 33071}],
    }

    def view(data, target=None):
        binary.extend(b'\0' * (-len(binary) % 4))
        result = {'buffer': 0, 'byteOffset': len(binary), 'byteLength': len(data)}
        if target:
            result['target'] = target
        binary.extend(data)
        gltf['bufferViews'].append(result)
        return len(gltf['bufferViews']) - 1

    def accessor(data, component_type, value_type, target, bounds=False, normalized=False, stride=None):
        result = {'bufferView': view(data.tobytes(), target), 'componentType': component_type, 'count': len(data), 'type': value_type}
        if stride:
            gltf['bufferViews'][result['bufferView']]['byteStride'] = stride
        if normalized:
            result['normalized'] = True
        if bounds:
            result['min'] = data.min(axis=0).tolist()
            result['max'] = data.max(axis=0).tolist()
        gltf['accessors'].append(result)
        return len(gltf['accessors']) - 1

    def shader_input(shader, name, fallback=None):
        input_value = shader.GetInput(name)
        value = input_value.Get() if input_value else None
        return value if value is not None else fallback

    def source_image(shader, name):
        input_value = shader.GetInput(name)
        connection = input_value.GetConnectedSource() if input_value else None
        if not connection:
            return None
        filename = connection[0].GetPrim().GetAttribute('inputs:file').Get()
        if not filename:
            return None
        return Image.open(io.BytesIO(archive.read(archive_names[Path(filename.path).name])))

    texture_cache = {}

    def texture(image):
        image = image.copy()
        image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        if image.mode not in ('RGB', 'RGBA'):
            image = image.convert('RGB')
        result = io.BytesIO()
        image.save(result, 'PNG', optimize=True)
        mime_type = 'image/png'
        if image.mode == 'RGB' and len(result.getvalue()) > 20000:
            result = io.BytesIO()
            image.save(result, 'JPEG', quality=90, optimize=True)
            mime_type = 'image/jpeg'
        data = result.getvalue()
        digest = hashlib.sha256(data).hexdigest()
        if digest not in texture_cache:
            index = len(gltf['textures'])
            gltf['images'].append({'bufferView': view(data), 'mimeType': mime_type})
            gltf['textures'].append({'source': index, 'sampler': 0})
            texture_cache[digest] = index
        return {'index': texture_cache[digest]}

    material_map = {}
    for prim in stage.Traverse():
        if not prim.IsA(UsdShade.Material):
            continue
        shader = next((UsdShade.Shader(child) for child in Usd.PrimRange(prim) if child.IsA(UsdShade.Shader) and UsdShade.Shader(child).GetIdAttr().Get() == 'UsdPreviewSurface'), None)
        if shader is None:
            continue
        color = list(shader_input(shader, 'diffuseColor', (1, 1, 1)))
        opacity = float(shader_input(shader, 'opacity', 1))
        roughness = float(shader_input(shader, 'roughness', 0.35))
        metallic = float(shader_input(shader, 'metallic', 0))
        # Average scalar texture maps; the small geometric details are preserved.
        for key in ('roughness', 'metallic'):
            image = source_image(shader, key)
            if image is not None:
                scalar = float(np.asarray(image.convert('L')).mean() / 255)
                if key == 'roughness':
                    roughness = scalar
                else:
                    metallic = scalar
        material = {'name': prim.GetName(), 'pbrMetallicRoughness': {'baseColorFactor': color + [opacity], 'metallicFactor': metallic, 'roughnessFactor': max(0.08, roughness)}}
        base_image = source_image(shader, 'diffuseColor')
        if base_image is not None:
            material['pbrMetallicRoughness']['baseColorFactor'] = [1, 1, 1, opacity]
            material['pbrMetallicRoughness']['baseColorTexture'] = texture(base_image)
        emissive_image = source_image(shader, 'emissiveColor')
        if emissive_image is not None:
            material['emissiveFactor'] = [1, 1, 1]
            material['emissiveTexture'] = texture(emissive_image)
        if opacity < 1:
            material['alphaMode'] = 'BLEND'
        material_map[str(prim.GetPath())] = len(gltf['materials'])
        gltf['materials'].append(material)

    def add_mesh(name, parent, positions, normals, uvs, material, source_path):
        values = np.round(np.concatenate([positions, normals, uvs], axis=1), 6).astype('<f4')
        unique, indices = np.unique(values, axis=0, return_inverse=True)
        indices = indices.astype('<u2' if len(unique) <= 65535 else '<u4')
        mesh = {'name': name, 'primitives': [{'attributes': {
            'POSITION': accessor(unique[:, :3].copy(), 5126, 'VEC3', 34962, True),
            'NORMAL': accessor(np.pad(np.rint(unique[:, 3:6] * 32767).astype('<i2'), ((0, 0), (0, 1))), 5122, 'VEC3', 34962, normalized=True, stride=8),
            'TEXCOORD_0': accessor(np.rint(np.clip(unique[:, 6:8], 0, 1) * 65535).astype('<u2'), 5123, 'VEC2', 34962, normalized=True),
        }, 'indices': accessor(indices, 5123 if indices.dtype.itemsize == 2 else 5125, 'SCALAR', 34963), 'material': material}]}
        gltf['nodes'][parent]['children'].append(len(gltf['nodes']))
        gltf['nodes'].append({'name': name, 'mesh': len(gltf['meshes']), 'extras': {'sourcePrim': source_path}})
        gltf['meshes'].append(mesh)

    triangle_count = 0
    for prim in stage.Traverse():
        if not prim.IsA(UsdGeom.Mesh) or prim.GetName() == COLLISION:
            continue
        if UsdGeom.Imageable(prim).ComputeVisibility() == 'invisible':
            continue
        mesh = UsdGeom.Mesh(prim)
        points = np.asarray(mesh.GetPointsAttr().Get(), dtype=np.float64)
        counts = np.asarray(mesh.GetFaceVertexCountsAttr().Get())
        face_indices = np.asarray(mesh.GetFaceVertexIndicesAttr().Get())
        normals = np.asarray(mesh.GetNormalsAttr().Get(), dtype=np.float64)
        matrix = np.asarray(transform_cache.GetLocalToWorldTransform(prim))
        positions = np.concatenate([points, np.ones((len(points), 1))], axis=1) @ matrix
        positions = positions[:, :3]
        normals = normals @ np.linalg.inv(matrix[:3, :3]).T
        normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)
        uv_primvar = UsdGeom.PrimvarsAPI(prim).GetPrimvar('st')
        uvs = np.asarray(uv_primvar.ComputeFlattened(), dtype=np.float64)
        normal_interpolation = mesh.GetNormalsInterpolation()
        uv_interpolation = uv_primvar.GetInterpolation()
        tris = []
        cursor = 0
        for count in counts:
            for step in range(1, count - 1):
                tris.append([cursor, cursor + step, cursor + step + 1])
            cursor += count
        face_vertices = np.asarray(tris).reshape(-1)
        point_vertices = face_indices[face_vertices]
        p = positions[point_vertices].copy()
        n = normals[face_vertices if normal_interpolation == 'faceVarying' else point_vertices].copy()
        uv = uvs[face_vertices if uv_interpolation == 'faceVarying' else point_vertices].copy()
        uv[:, 1] = 1 - uv[:, 1]
        source_path = str(prim.GetPath())
        mat = UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()[0]
        material = material_map[str(mat.GetPath())]
        if GROUP_COVER in source_path:
            groups = [(1, np.ones(len(p) // 3, dtype=bool))]
        elif GROUP_BACK in source_path:
            groups = [(2, np.ones(len(p) // 3, dtype=bool))]
        elif prim.GetName() == HINGE:
            groups = [(3, np.ones(len(p) // 3, dtype=bool))]
        else:
            # The flexible glass is one mesh wrapped around the closed hinge.
            left = p.reshape(-1, 3, 3)[:, :, 2].mean(axis=1) > 0
            groups = [(1, left), (2, ~left)]
        for group, mask in groups:
            selection = np.repeat(mask, 3)
            part, normal, texcoord = p[selection].copy(), n[selection].copy(), uv[selection].copy()
            if not len(part):
                continue
            part[:, 0] -= HINGE_X
            part[:, 1] -= CENTER_Y
            if group == 1:
                part[:, [0, 2]] *= -1
                normal[:, [0, 2]] *= -1
            if group == 3:
                # Recess the closed-pose hinge barrel behind the inner screen.
                part[:, 0] += 0.105
                part[:, 2] = part[:, 2] * 0.55 - 0.28
            name = prim.GetName() + ('-left' if group == 1 else '-right' if group == 2 else '')
            if prim.GetName() == INNER_SCREEN:
                name = 'duo-screen-left' if group == 1 else 'duo-screen-right'
                # The source UVs describe the unfolded display. Flatten only the
                # flexible display while preserving Apple's outline and cutouts.
                part[:, 0] = (texcoord[:, 0] - 0.5) * INNER_HALF_WIDTH * 2
                part[:, 2] = -0.025
                normal[:] = [0, 0, 1]
            elif prim.GetName() == COVER_SCREEN:
                name = 'duo-screen-cover'
            triangle_count += len(part) // 3
            add_mesh(name, group, part, normal, texcoord, material, source_path)

    gltf['buffers'] = [{'byteLength': len(binary)}]
    metadata = json.dumps(gltf, separators=(',', ':')).encode()
    metadata += b' ' * (-len(metadata) % 4)
    binary += b'\0' * (-len(binary) % 4)
    glb = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(metadata) + 8 + len(binary))
    glb += struct.pack('<I4s', len(metadata), b'JSON') + metadata
    glb += struct.pack('<I4s', len(binary), b'BIN\0') + binary
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(base64.b64encode(glb).decode() + '\n')
    print(json.dumps({'output': str(output), 'binaryBytes': len(glb), 'meshes': len(gltf['meshes']), 'triangles': triangle_count, 'sourceSha256': source_hash}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, help='Downloaded Apple USDZ; otherwise downloads the official source.')
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'src/client/assets/iphone-duo-model.glb.base64')
    args = parser.parse_args()
    if args.source:
        convert(args.source, args.output)
    else:
        with tempfile.TemporaryDirectory(prefix='serve-sim-duo-model-') as directory:
            downloaded = Path(directory) / 'iphone-duo.usdz'
            urllib.request.urlretrieve(SOURCE, downloaded)
            convert(downloaded, args.output)
