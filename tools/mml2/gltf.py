"""Tiny glTF 2.0 binary (.glb) writer: just what tools/mml2/models.py needs."""
import io
import json
import struct

import numpy as np

FLOAT, UBYTE, USHORT, UINT = 5126, 5121, 5123, 5125
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963


class Glb:
    def __init__(self):
        self.bin = bytearray()
        self.json = {'asset': {'version': '2.0', 'generator': 'tools/mml2/models.py'},
                     'buffers': [{}], 'bufferViews': [], 'accessors': []}

    def view(self, data, target=None):
        while len(self.bin) % 4:
            self.bin.append(0)
        v = {'buffer': 0, 'byteOffset': len(self.bin), 'byteLength': len(data)}
        if target:
            v['target'] = target
        self.bin += data
        self.json['bufferViews'].append(v)
        return len(self.json['bufferViews']) - 1

    def accessor(self, array, kind, component, target=None, minmax=False, normalized=False):
        array = np.ascontiguousarray(array)
        a = {'bufferView': self.view(array.tobytes(), target), 'componentType': component,
             'count': int(array.shape[0]), 'type': kind}
        if normalized:
            a['normalized'] = True
        if minmax:
            flat = array.reshape(array.shape[0], -1)
            a['min'] = [float(x) for x in flat.min(axis=0)]
            a['max'] = [float(x) for x in flat.max(axis=0)]
        self.json['accessors'].append(a)
        return len(self.json['accessors']) - 1

    def add(self, key, obj):
        self.json.setdefault(key, []).append(obj)
        return len(self.json[key]) - 1

    def png(self, image):
        buf = io.BytesIO()
        image.save(buf, 'PNG')
        return self.add('images', {'bufferView': self.view(buf.getvalue()), 'mimeType': 'image/png'})

    def write(self, path):
        while len(self.bin) % 4:
            self.bin.append(0)
        self.json['buffers'][0]['byteLength'] = len(self.bin)
        js = json.dumps(self.json, separators=(',', ':')).encode()
        js += b' ' * (-len(js) % 4)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        with open(path, 'wb') as f:
            f.write(struct.pack('<4sII', b'glTF', 2, total))
            f.write(struct.pack('<I4s', len(js), b'JSON'))
            f.write(js)
            f.write(struct.pack('<I4s', len(self.bin), b'BIN\0'))
            f.write(self.bin)
