"""Verify a device archive and its embedded executable dependencies before signing."""

import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import subprocess
from verify_web_payload import verify_web_payload
from verify_speech_payload import verify_speech_payload


def file_hash(file):
    digest = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_archive(archive, version, build_number, web_dir=None, speech_dir=None):
    app = archive / "Products/Applications/App.app"
    info = plistlib.loads((app / "Info.plist").read_bytes())
    if (info["CFBundleIdentifier"] != "com.bendyline.gezel.mobile"
            or info["CFBundleShortVersionString"] != version
            or info["CFBundleVersion"] != build_number
            or info["MinimumOSVersion"] != "16.4"):
        raise ValueError("Unexpected release identity, version, or minimum iOS version")
    for relative in ("PrivacyInfo.xcprivacy", "public/index.html", "public/preview-isolation.js",
                     "public/licenses/LICENSE-gezel.txt", "public/licenses/npm/manifest.json",
                     "public/licenses/native/LICENSE-llama-cpp.txt",
                     "public/licenses/native/LICENSE-ggml.txt", "public/licenses/native/LICENSE-whisper.txt",
                     "public/licenses/native/LICENSE-kokoro.txt",
                     "public/licenses/native/LICENSE-onnxruntime.txt", "public/licenses/native/NOTICE-onnxruntime.txt"):
        if not (app / relative).is_file():
            raise ValueError(f"Missing release asset: {relative}")
    payload = []
    for file in sorted(app.rglob("*")):
        if file.is_symlink():
            raise ValueError(f"Unexpected symlink in the device app: {file}")
        if file.is_file() and (file.suffix == ".gguf" or file.name == "mobile-product-eval.js"):
            raise ValueError(f"A model or test fixture is embedded in the release: {file}")
        if file.is_file():
            payload.append([file.relative_to(app).as_posix(), file.stat().st_size, file_hash(file)])
    binaries = [app / info["CFBundleExecutable"]]
    if not (app / 'Frameworks/GezelSpeech.framework/GezelSpeech').is_file():
        raise ValueError('Missing native speech framework')
    for framework in (app / "Frameworks").glob("*.framework"):
        framework_info = plistlib.loads((framework / "Info.plist").read_bytes())
        binaries.append(framework / framework_info["CFBundleExecutable"])
    binaries.extend((app / "Frameworks").glob("*.dylib"))
    verified = []
    for binary in binaries:
        archs = subprocess.check_output(["xcrun", "lipo", "-archs", str(binary)], text=True).split()
        if archs != ["arm64"]:
            raise ValueError(f"Unexpected release architecture for {binary}: {archs}")
        build = subprocess.check_output(["xcrun", "vtool", "-show-build", str(binary)], text=True)
        if not re.search(r"^\s*platform IOS$", build, re.MULTILINE):
            raise ValueError(f"The archive contains a non-device executable: {binary}")
        minos = re.search(r"^\s*minos ([0-9.]+)$", build, re.MULTILINE)
        if not minos or tuple((list(map(int, minos[1].split("."))) + [0, 0])[:3]) > (16, 4, 0):
            raise ValueError(f"An embedded executable requires a newer OS than the app: {binary}")
        dependencies = subprocess.check_output(["xcrun", "otool", "-L", str(binary)], text=True)
        for line in dependencies.splitlines()[1:]:
            dependency = line.strip().split(" (", 1)[0]
            if dependency.startswith(("/System/Library/", "/usr/lib/")):
                continue
            if dependency.startswith("@rpath/") and (app / "Frameworks" / dependency[7:]).is_file():
                continue
            raise ValueError(f"An executable dependency is not packaged: {dependency}")
        verified.append({"path": str(binary.relative_to(app)), "bytes": binary.stat().st_size,
                         "sha256": file_hash(binary)})
    result = {"archive": str(archive), "architecture": "arm64", "minimumIOS": "16.4",
            "productionAssets": "passed", "binaries": verified, "fileCount": len(payload),
            "appPayloadSHA256": hashlib.sha256(json.dumps(payload, separators=(",", ":"),
                                                          ensure_ascii=True).encode()).hexdigest()}
    if web_dir is not None:
        result["webPayload"] = verify_web_payload(web_dir, lambda relative: (app / "public" / relative).open("rb"))
    staged_speech = speech_dir or Path(__file__).resolve().parents[1] / '.build/speech/assets/speech'
    result['speechPayload'] = verify_speech_payload(staged_speech, lambda name: (app / 'speech' / name).open('rb'))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--version", required=True)
    parser.add_argument("--build-number", required=True)
    parser.add_argument("--web-dir", type=Path, help="Require every compiled web file to match the packaged public assets")
    args = parser.parse_args()
    print(json.dumps(verify_archive(args.archive, args.version, args.build_number, args.web_dir), indent=2))
