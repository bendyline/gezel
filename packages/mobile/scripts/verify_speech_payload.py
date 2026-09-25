"""Verify packaged speech assets against the staged, pinned offline pack."""
import hashlib
import json
from pathlib import PurePosixPath

def verify_speech_payload(source, open_packaged):
    manifest = json.loads((source / 'manifest.json').read_text())
    with open_packaged('manifest.json') as stream:
        if stream.read() != (source / 'manifest.json').read_bytes():
            raise ValueError('Packaged speech inventory is stale')
    for name, expected in manifest.items():
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or '\\' in name:
            raise ValueError('Invalid speech asset path')
        digest = hashlib.sha256()
        with open_packaged(name) as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b''): digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError('Packaged speech asset differs: ' + name)
    if not all(name in manifest for name in ['whisper-tiny.bin', 'kokoro/model.int8.onnx', 'voices.json', 'pack.json']):
        raise ValueError('Offline speech pack is incomplete')
    return {'files': len(manifest), 'integrity': 'passed'}
