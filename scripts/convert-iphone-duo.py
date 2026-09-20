#!/usr/bin/env python3
"""Convert Apple's iPhone Duo USDZ into a self-contained articulated GLB.

Requires Python packages usd-core, numpy, Pillow. Run with SOURCE.usdz OUTPUT_DIR.
The original USDZ is an input, not redistributed by this script.
"""
from __future__ import annotations
import argparse
import base64
import gzip
import hashlib
import io
import json
from pathlib import Path
import struct
import tempfile
import zipfile
import numpy as np
from PIL import Image
from pxr import Usd, UsdGeom, UsdShade

SOURCE_URL = 'https://www.apple.com/105/media/us/iphone-duo/2026/9305e4b9-72d9-4c05-9381-b572adadd5e5/ar/iPhone_Duo_e-sim_Star-White_Variant.usdz'
CENTER_Y = 5.8973725
HINGE_Z = 0.249478
MAX_TEXTURE_SIZE = 1024
INNER_DISPLAY = 'UXtsBZYlaUvHoEh'
COVER_DISPLAY = 'hhgAIoCGsHXeDPY'
# The USDZ includes an enclosing black box, unrelated to device surfaces.
ENCLOSING_BOX = 'lJPfQMFXvvcmdtA'

def convert(source: Path, output: Path, write_glb: bool = False):
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='iphone-duo-usd-') as unpacked:
        with zipfile.ZipFile(source) as archive:
            archive.extractall(unpacked)
            root = Path(unpacked) / archive.namelist()[0]
        stage = Usd.Stage.Open(str(root))
        stage.GetDefaultPrim().GetVariantSet('Color').SetVariantSelection('Star_White')
        stage.GetDefaultPrim().GetVariantSet('Pose').SetVariantSelection('Landscape')
        document = {
            'asset': {'version': '2.0', 'generator': 'serve-sim Apple USDZ converter', 'copyright': 'Original model: Apple Inc.'},
            'scene': 0, 'scenes': [{'nodes': [0]}],
            'nodes': [{'name': 'iphone-duo', 'children': [1, 2]}, {'name': 'left-half', 'children': []}, {'name': 'right-half', 'children': []}],
            'meshes': [], 'materials': [], 'textures': [], 'images': [],
            'samplers': [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}, {'magFilter': 9729, 'minFilter': 9987, 'wrapS': 33071, 'wrapT': 33071}],
            'accessors': [], 'bufferViews': [], 'buffers': [],
            'extensionsUsed': ['KHR_materials_clearcoat'],
        }
        blob = bytearray()
        texture_cache = {}
        material_cache = {}
        bounds = []
        triangles = 0

        def buffer_view(data, target=None):
            while len(blob) % 4:
                blob.append(0)
            view = {'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(data)}
            if target:
                view['target'] = target
            index = len(document['bufferViews'])
            document['bufferViews'].append(view)
            blob.extend(data)
            return index

        def accessor(values, kind, component=5126, target=34962):
            arr = np.asarray(values, dtype='<f4' if component == 5126 else '<u4')
            obj = {'bufferView': buffer_view(arr.tobytes(), target), 'componentType': component, 'count': len(arr), 'type': kind}
            if kind == 'VEC3':
                obj['min'], obj['max'] = arr.min(axis=0).tolist(), arr.max(axis=0).tolist()
            index = len(document['accessors'])
            document['accessors'].append(obj)
            return index

        def image_for(info):
            if not info:
                return None
            image = Image.open(info['path'])
            image.thumbnail((MAX_TEXTURE_SIZE, MAX_TEXTURE_SIZE), Image.Resampling.LANCZOS)
            return image

        def texture_for(image, key, clamp=False):
            cache_key = (key, clamp)
            if cache_key in texture_cache:
                return texture_cache[cache_key]
            stream = io.BytesIO()
            image.save(stream, format='PNG', optimize=True)
            image_index = len(document['images'])
            document['images'].append({'bufferView': buffer_view(stream.getvalue()), 'mimeType': 'image/png'})
            index = len(document['textures'])
            document['textures'].append({'source': image_index, 'sampler': 1 if clamp else 0})
            texture_cache[cache_key] = index
            return index

        def input_texture(shader, name):
            inp = shader.GetInput(name)
            if not inp:
                return None
            connections, _ = inp.GetConnectedSources()
            if not connections:
                return None
            texture = UsdShade.Shader(connections[0].source.GetPrim())
            asset = texture.GetInput('file').Get() if texture.GetInput('file') else None
            if not asset:
                return None
            path = asset.resolvedPath
            if not path:
                candidates = list(Path(unpacked).rglob(Path(asset.path).name))
                if not candidates:
                    return None
                path = str(candidates[0])
            uv = 0
            tex_st = texture.GetInput('st')
            if tex_st:
                uv_connections, _ = tex_st.GetConnectedSources()
                if uv_connections:
                    reader = UsdShade.Shader(uv_connections[0].source.GetPrim())
                    if reader.GetInput('varname').Get() == 'st1':
                        uv = 1
            return {'path': path, 'uv': uv, 'clamp': texture.GetInput('wrapS').Get() == 'clamp' if texture.GetInput('wrapS') else False}

        def constant(shader, name, default):
            inp = shader.GetInput(name)
            value = inp.Get() if inp else None
            if value is None:
                return default
            if isinstance(default, list):
                return list(value)
            return float(value)

        def texture_info(info):
            return {'index': texture_for(image_for(info), info['path'], info['clamp']), 'texCoord': info['uv']}

        def material_index(material):
            name = material.GetPrim().GetName()
            if name in material_cache:
                return material_cache[name]
            shader = next(UsdShade.Shader(p) for p in Usd.PrimRange(material.GetPrim()) if p.IsA(UsdShade.Shader) and UsdShade.Shader(p).GetIdAttr().Get() == 'UsdPreviewSurface')
            base = constant(shader, 'diffuseColor', [1, 1, 1])
            opacity = constant(shader, 'opacity', 1)
            rough = constant(shader, 'roughness', 0.5)
            metal = constant(shader, 'metallic', 0)
            mat = {'name': name, 'pbrMetallicRoughness': {'baseColorFactor': base + [opacity], 'roughnessFactor': rough, 'metallicFactor': metal}}
            diffuse = input_texture(shader, 'diffuseColor')
            alpha = input_texture(shader, 'opacity')
            if alpha:
                diffuse_image = image_for(diffuse).convert('RGBA') if diffuse else Image.new('RGBA', image_for(alpha).size, (255, 255, 255, 255))
                diffuse_image.putalpha(image_for(alpha).convert('L').resize(diffuse_image.size, Image.Resampling.LANCZOS))
                mat['pbrMetallicRoughness']['baseColorTexture'] = {'index': texture_for(diffuse_image, str((diffuse, alpha))), 'texCoord': (diffuse or alpha)['uv']}
                mat['pbrMetallicRoughness']['baseColorFactor'][3] = 1
                mat['alphaMode'] = 'BLEND'
            elif diffuse:
                mat['pbrMetallicRoughness']['baseColorTexture'] = texture_info(diffuse)
            if opacity < 1:
                mat['alphaMode'] = 'BLEND'
            rough_map = input_texture(shader, 'roughness')
            metal_map = input_texture(shader, 'metallic')
            if rough_map or metal_map:
                reference = rough_map or metal_map
                size = image_for(reference).size
                rough_image = image_for(rough_map).convert('L').resize(size) if rough_map else Image.new('L', size, round(rough * 255))
                metal_image = image_for(metal_map).convert('L').resize(size) if metal_map else Image.new('L', size, round(metal * 255))
                packed = Image.merge('RGB', [Image.new('L', size, 255), rough_image, metal_image])
                mat['pbrMetallicRoughness'].update({'roughnessFactor': 1, 'metallicFactor': 1, 'metallicRoughnessTexture': {'index': texture_for(packed, str((rough_map, metal_map, rough, metal))), 'texCoord': reference['uv']}})
            for usd_name, gltf_name in [('normal', 'normalTexture'), ('occlusion', 'occlusionTexture'), ('emissiveColor', 'emissiveTexture')]:
                info = input_texture(shader, usd_name)
                if info:
                    mat[gltf_name] = texture_info(info)
                    if usd_name == 'emissiveColor':
                        mat['emissiveFactor'] = [1, 1, 1]
            clearcoat = constant(shader, 'clearcoat', 0)
            if clearcoat:
                mat['extensions'] = {'KHR_materials_clearcoat': {'clearcoatFactor': clearcoat, 'clearcoatRoughnessFactor': constant(shader, 'clearcoatRoughness', .1)}}
            index = len(document['materials'])
            document['materials'].append(mat)
            material_cache[name] = index
            return index

        def flatten_attribute(values, interpolation, point_indices, counts, dimension):
            arr = np.asarray(values, dtype=np.float64)
            if not len(arr):
                return np.zeros((len(point_indices), dimension))
            if interpolation == 'faceVarying':
                return arr
            if interpolation in ('vertex', 'varying'):
                return arr[point_indices]
            if interpolation == 'uniform':
                return np.repeat(arr, counts, axis=0)
            return np.tile(arr[0], (len(point_indices), 1))

        def clip_polygon(polygon, sign):
            result = []
            for i, current in enumerate(polygon):
                previous = polygon[i - 1]
                current_inside, previous_inside = sign * current[0] >= -1e-9, sign * previous[0] >= -1e-9
                if current_inside != previous_inside:
                    weight = previous[0] / (previous[0] - current[0])
                    intersection = previous + weight * (current - previous)
                    intersection[0] = 0
                    result.append(intersection)
                if current_inside:
                    result.append(current)
            return result

        for prim in stage.Traverse():
            if not prim.IsA(UsdGeom.Mesh) or prim.GetName() == ENCLOSING_BOX or UsdGeom.Imageable(prim).ComputeVisibility() == 'invisible':
                continue
            mesh = UsdGeom.Mesh(prim)
            points = np.array(mesh.GetPointsAttr().Get(), dtype=np.float64)
            matrix = np.array(UsdGeom.Xformable(prim).ComputeLocalToWorldTransform(0))
            points = (np.c_[points, np.ones(len(points))] @ matrix)[:, :3]
            points -= [0, CENTER_Y, HINGE_Z]
            indices = np.array(mesh.GetFaceVertexIndicesAttr().Get(), dtype=np.int32)
            counts = np.array(mesh.GetFaceVertexCountsAttr().Get(), dtype=np.int32)
            normals = flatten_attribute(mesh.GetNormalsAttr().Get(), mesh.GetNormalsInterpolation(), indices, counts, 3)
            normals = normals @ np.linalg.inv(matrix[:3, :3]).T
            normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-8)
            attrs = [points[indices], normals]
            for uv_name in ['st', 'st1']:
                pv = UsdGeom.PrimvarsAPI(prim).GetPrimvar(uv_name)
                uv = flatten_attribute(pv.ComputeFlattened() if pv else [], pv.GetInterpolation() if pv else 'constant', indices, counts, 2)
                uv[:, 1] = 1 - uv[:, 1]
                attrs.append(uv)
            corners = np.concatenate(attrs, axis=1)
            halves = {1: [], 2: []}
            offset = 0
            for count in counts:
                polygon = corners[offset:offset + count]
                offset += count
                for half, sign in [(1, -1), (2, 1)]:
                    clipped = clip_polygon(polygon, sign)
                    for i in range(1, len(clipped) - 1):
                        tri = [clipped[0], clipped[i], clipped[i + 1]]
                        if np.linalg.norm(np.cross(tri[1][:3] - tri[0][:3], tri[2][:3] - tri[0][:3])) > 1e-11:
                            halves[half].extend(tri)
            material = material_index(UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()[0])
            for half, corners in halves.items():
                if not corners:
                    continue
                arr, indices = np.unique(np.asarray(corners, dtype='<f4'), axis=0, return_inverse=True)
                name = prim.GetName()
                if name == INNER_DISPLAY:
                    name = 'inner-display-' + ('left' if half == 1 else 'right')
                elif name == COVER_DISPLAY:
                    name = 'cover-display'
                elif name == 'JnJdTkxbQgUtLwU':
                    name = 'inner-bezel-' + ('left' if half == 1 else 'right')
                elif name == 'MvKPXGSdYDVvSpk':
                    name = 'hinge-' + ('left' if half == 1 else 'right')
                mesh_index = len(document['meshes'])
                document['meshes'].append({'name': name, 'primitives': [{'attributes': {'POSITION': accessor(arr[:, :3], 'VEC3'), 'NORMAL': accessor(arr[:, 3:6], 'VEC3'), 'TEXCOORD_0': accessor(arr[:, 6:8], 'VEC2'), 'TEXCOORD_1': accessor(arr[:, 8:10], 'VEC2')}, 'indices': accessor(indices, 'SCALAR', 5125, 34963), 'material': material}]})
                node_index = len(document['nodes'])
                document['nodes'].append({'name': name, 'mesh': mesh_index})
                document['nodes'][half]['children'].append(node_index)
                bounds.extend(arr[:, :3])
                triangles += len(indices) // 3
        document['buffers'] = [{'byteLength': len(blob)}]
        encoded = json.dumps(document, separators=(',', ':')).encode()
        encoded += b' ' * (-len(encoded) % 4)
        blob.extend(b'\0' * (-len(blob) % 4))
        binary = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(encoded) + 8 + len(blob)) + struct.pack('<II', len(encoded), 0x4E4F534A) + encoded + struct.pack('<II', len(blob), 0x004E4942) + blob
        if write_glb:
            (output / 'iphone-duo.glb').write_bytes(binary)
        (output / 'model.glb.gz.txt').write_text(base64.b64encode(gzip.compress(binary, compresslevel=9, mtime=0)).decode() + '\n')
        bounds = np.array(bounds)
        report = {'source': SOURCE_URL, 'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'sourceBytes': source.stat().st_size, 'glbBytes': len(binary), 'gzipBytes': len(gzip.compress(binary, mtime=0)), 'meshCount': len(document['meshes']), 'triangleCount': triangles, 'bounds': [bounds.min(axis=0).tolist(), bounds.max(axis=0).tolist()], 'centerY': CENTER_Y, 'hingeZ': HINGE_Z}
        (output / 'conversion.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--write-glb', action='store_true', help='Also write an uncompressed GLB for local inspection')
    args = parser.parse_args()
    convert(args.source, args.output, args.write_glb)
