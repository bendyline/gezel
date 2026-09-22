"""Check the actual release archive, including transitive native libraries."""

import argparse
import importlib.util
import json
import re
from pathlib import Path, PurePosixPath
import subprocess
import tempfile
import zipfile
from verify_web_payload import verify_web_payload
from verify_speech_payload import verify_speech_payload


def verify_archive(archive, readelf, web_dir=None, speech_dir=None):
    repo = Path(__file__).resolve().parents[3]
    spec = importlib.util.spec_from_file_location("mobile_build", repo / "native/mobile/build-llama.py")
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    root = "base/" if archive.suffix == ".aab" else ""
    assets = root + "assets/public/"
    with zipfile.ZipFile(archive) as payload, tempfile.TemporaryDirectory(prefix="gezel-release-elf-") as temporary:
        names = payload.namelist()
        if len(set(names)) != len(names):
            raise ValueError("Release archive has duplicate entries")
        for name in names:
            if name.endswith(("mobile-product-eval.js", "ios-fixture.gguf")) or name.endswith(".gguf"):
                raise ValueError(f"A test fixture or model is embedded in the production archive: {name}")
        for required in ("index.html", "preview-isolation.js", "licenses/LICENSE-gezel.txt",
                         "licenses/npm/manifest.json", "licenses/native/LICENSE-llama-cpp.txt",
                         "licenses/native/LICENSE-ggml.txt", "licenses/native/LICENSE-whisper.txt",
                         "licenses/native/LICENSE-kokoro.txt",
                         "licenses/native/LICENSE-onnxruntime.txt", "licenses/native/NOTICE-onnxruntime.txt"):
            if assets + required not in names:
                raise ValueError(f"Missing release asset: {required}")
        libraries = [name for name in names if name.startswith(root + "lib/") and name.endswith(".so")]
        if not libraries:
            raise ValueError("Release archive contains no native libraries")
        abis = {PurePosixPath(name).parts[-2] for name in libraries}
        if abis != {"arm64-v8a"}:
            raise ValueError(f"Unexpected Android ABIs: {sorted(abis)}")
        packaged = [PurePosixPath(name).name for name in libraries]
        if "libgezel_mobile.so" not in packaged or "libgezel-llama.so" not in packaged:
            raise ValueError("Missing Gezel JNI or inference library")
        if not all(name in packaged for name in ['libGezelSpeech.so', 'libonnxruntime.so']):
            raise ValueError('Missing native speech libraries')
        for name in libraries:
            if payload.getinfo(name).file_size > 256 * 1024 * 1024:
                raise ValueError(f"Native library exceeds verification limit: {name}")
            file = Path(temporary) / PurePosixPath(name).name
            file.write_bytes(payload.read(name))
            identity = subprocess.check_output([str(readelf), "-hW", str(file)], text=True)
            if (not re.search(r"^\s*Class:\s+ELF64\s*$", identity, re.MULTILINE)
                    or not re.search(r"^\s*Machine:\s+AArch64\s*$", identity, re.MULTILINE)):
                raise ValueError(f"A packaged native library is not arm64 ELF64: {name}")
            headers = subprocess.check_output([str(readelf), "-lW", str(file)], text=True)
            build.verify_elf_alignment(headers)
            dynamic = subprocess.check_output([str(readelf), "-dW", str(file)], text=True)
            build.verify_elf_dependencies(dynamic, packaged)
        result = {"archive": str(archive), "abis": sorted(abis), "elfLibraries": len(libraries),
                "elfPageAlignment": 16384, "productionAssets": "passed"}
        staged_speech = speech_dir or repo / 'packages/mobile/android/app/src/main/assets/speech'
        result['speechPayload'] = verify_speech_payload(staged_speech, lambda name: payload.open(root + 'assets/speech/' + name))
        if web_dir is not None:
            result["webPayload"] = verify_web_payload(web_dir, lambda relative: payload.open(assets + relative))
        return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--readelf", required=True, type=Path)
    parser.add_argument("--web-dir", type=Path, help="Require every compiled web file to match the packaged public assets")
    args = parser.parse_args()
    print(json.dumps(verify_archive(args.archive, args.readelf, args.web_dir), indent=2))
