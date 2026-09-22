"""Release archive boundaries, using synthetic archives and native tool receipts."""
import importlib.util
import hashlib
from pathlib import Path
import plistlib
import json
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


android = load("verify-android-package")
ios = load("verify-ios-archive")
# Every asset both release verifiers require. The speech stack was added to
# the verifiers when offline speech landed; these fixtures have to carry the
# same set or the bridge job fails before it checks anything real.
ASSETS = ["index.html", "preview-isolation.js", "licenses/LICENSE-gezel.txt",
          "licenses/npm/manifest.json", "licenses/native/LICENSE-llama-cpp.txt",
          "licenses/native/LICENSE-ggml.txt", "licenses/native/LICENSE-whisper.txt",
          "licenses/native/LICENSE-kokoro.txt", "licenses/native/LICENSE-onnxruntime.txt",
          "licenses/native/NOTICE-onnxruntime.txt"]


SPEECH_FILES = {"whisper-tiny.bin": b"whisper weights", "kokoro/model.int8.onnx": b"kokoro weights",
                "voices.json": b"[]", "pack.json": b"{}"}


def staged_speech(root):
    """Write a staged offline speech pack and return it with its manifest bytes."""
    directory = root / "staged-speech"
    manifest = {}
    for name, content in SPEECH_FILES.items():
        file = directory / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(content)
        manifest[name] = hashlib.sha256(content).hexdigest()
    body = json.dumps(manifest).encode()
    (directory / "manifest.json").write_bytes(body)
    packaged = {"manifest.json": body, **SPEECH_FILES}
    return directory, packaged


def compiled_web(root, index):
    files = {"index.html": index, "assets/client.js": b"compiled-v1",
             "assets/nested/font bytes.woff2": b"\x00\xff" * (512 * 1024 + 3),
             "empty.txt": b""}
    for name, content in files.items():
        file = root / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(content)
    return files


class AndroidReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.speech, self.packaged_speech = staged_speech(self.root)

    def archive(self, suffix=".apk", omit=None, extra=(), contents=None):
        archive = self.root / ("app" + suffix)
        prefix = "base/" if suffix == ".aab" else ""
        names = [prefix + "assets/public/" + name for name in ASSETS]
        speech = {prefix + "assets/speech/" + name: body
                  for name, body in self.packaged_speech.items()}
        names += list(speech)
        names += [prefix + "lib/arm64-v8a/" + name for name in
                  ["libgezel_mobile.so", "libgezel-llama.so", "libGezelSpeech.so",
                   "libonnxruntime.so"]]
        with warnings.catch_warnings(), zipfile.ZipFile(archive, "w") as output:
            warnings.simplefilter("ignore", UserWarning)
            for name in names + list(extra):
                if name != omit:
                    output.writestr(name, (contents or {}).get(name, speech.get(name, b"fixture")))
        return archive

    def verify(self, archive, machine="AArch64", alignment="0x4000", dependency="libc.so", web_dir=None):
        def command(args, **_kwargs):
            return {"-hW": f"Class: ELF64\nMachine: {machine}\n",
                    "-lW": f" LOAD 0 0 0 0 0 R E {alignment}\n",
                    "-dW": f" (NEEDED) Shared library: [{dependency}]\n"}[args[1]]
        with patch.object(android.subprocess, "check_output", side_effect=command):
            return android.verify_archive(archive, Path("readelf"), web_dir, self.speech)

    def test_compiled_web_matches_apk_and_bundle_and_allows_native_extras(self):
        web_dir = self.root / "dist"
        files = compiled_web(web_dir, b"fixture")
        for suffix in [".apk", ".aab"]:
            with self.subTest(suffix=suffix):
                prefix = ("base/" if suffix == ".aab" else "") + "assets/public/"
                contents = {prefix + name: content for name, content in files.items()}
                extra = [prefix + name for name in files if name not in ASSETS]
                result = self.verify(self.archive(suffix, extra=extra, contents=contents), web_dir=web_dir)
                self.assertEqual(result["webPayload"], {"fileCount": len(files),
                    "indexSHA256": hashlib.sha256(b"fixture").hexdigest(), "byteIdentical": True})

    def test_rejects_missing_or_changed_compiled_web_in_apk_and_bundle(self):
        web_dir = self.root / "dist"
        files = compiled_web(web_dir, b"fixture")
        for suffix in [".apk", ".aab"]:
            prefix = ("base/" if suffix == ".aab" else "") + "assets/public/"
            original = {prefix + name: content for name, content in files.items()}
            extra = [prefix + name for name in files if name not in ASSETS]
            for change in ["missing", "changed", "truncated", "appended"]:
                with self.subTest(suffix=suffix, change=change):
                    contents = dict(original)
                    asset = prefix + "assets/client.js"
                    omit = asset if change == "missing" else None
                    if change == "changed": contents[asset] = b"compiled-v2"
                    if change == "truncated": contents[asset] = b"compiled-v"
                    if change == "appended": contents[asset] += b"extra"
                    archive = self.archive(suffix, omit=omit, extra=extra, contents=contents)
                    message = "Missing packaged web asset" if change == "missing" else "differs from compiled source"
                    with self.assertRaisesRegex(ValueError, message + ": assets/client.js"):
                        self.verify(archive, web_dir=web_dir)

    def test_apk_and_bundle_verify_all_native_libraries(self):
        for suffix in [".apk", ".aab"]:
            with self.subTest(suffix=suffix):
                result = self.verify(self.archive(suffix))
                self.assertEqual(result["abis"], ["arm64-v8a"])
                self.assertEqual(result["elfLibraries"], 4)

    def test_rejects_missing_license_or_jni(self):
        for missing in ["assets/public/licenses/native/LICENSE-ggml.txt", "lib/arm64-v8a/libgezel_mobile.so"]:
            with self.subTest(missing=missing), self.assertRaisesRegex(ValueError, "Missing"):
                self.verify(self.archive(omit=missing))

    def test_rejects_duplicate_archive_entries(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.verify(self.archive(extra=["assets/public/index.html"]))

    def test_rejects_models_and_test_eval_assets(self):
        for name in ["assets/public/model.gguf", "assets/public/mobile-product-eval.js"]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "test fixture or model"):
                self.verify(self.archive(extra=[name]))

    def test_rejects_wrong_abi_or_actual_machine_even_when_the_folder_claims_arm64(self):
        with self.assertRaisesRegex(ValueError, "Unexpected Android ABIs"):
            self.verify(self.archive(extra=["lib/x86_64/extra.so"]))
        with self.assertRaisesRegex(ValueError, "not arm64 ELF64"):
            self.verify(self.archive(), machine="Advanced Micro Devices X86-64")

    def test_rejects_unaligned_or_unbundled_transitive_libraries(self):
        with self.assertRaisesRegex(ValueError, "16 KB"):
            self.verify(self.archive(), alignment="0x1000")
        with self.assertRaisesRegex(ValueError, "unbundled dependencies"):
            self.verify(self.archive(), dependency="libmissing.so")


class IOSReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.archive = Path(self.temporary.name) / "Gezel.xcarchive"
        self.app = self.archive / "Products/Applications/App.app"
        self.info = {"CFBundleIdentifier": "com.bendyline.gezel.mobile", "CFBundleShortVersionString": "1.2.3",
                     "CFBundleVersion": "12", "MinimumOSVersion": "16.4", "CFBundleExecutable": "App"}
        self.put("Info.plist", plistlib.dumps(self.info))
        self.put("App", b"mach-o fixture")
        self.put("PrivacyInfo.xcprivacy", b"privacy fixture")
        self.put("Frameworks/Capacitor.framework/Info.plist", plistlib.dumps({"CFBundleExecutable": "Capacitor"}))
        self.put("Frameworks/Capacitor.framework/Capacitor", b"framework fixture")
        # Offline speech ships as its own framework, and the verifier requires it.
        self.put("Frameworks/GezelSpeech.framework/Info.plist", plistlib.dumps({"CFBundleExecutable": "GezelSpeech"}))
        self.put("Frameworks/GezelSpeech.framework/GezelSpeech", b"speech fixture")
        self.speech, packaged_speech = staged_speech(Path(self.temporary.name))
        for name, body in packaged_speech.items():
            self.put("speech/" + name, body)
        for name in ASSETS:
            self.put("public/" + name, b"asset fixture")

    def put(self, name, content):
        file = self.app / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(content)

    def verify(self, arch="arm64", platform="IOS", minos="16.4", dependency="@rpath/Capacitor.framework/Capacitor", web_dir=None):
        def command(args, **_kwargs):
            return {"lipo": arch + "\n", "vtool": f" platform {platform}\n minos {minos}\n",
                    "otool": f"binary:\n {dependency} (compatibility version 1.0.0)\n"}[args[1]]
        with patch.object(ios.subprocess, "check_output", side_effect=command):
            return ios.verify_archive(self.archive, "1.2.3", "12", web_dir, self.speech)

    def test_compiled_web_matches_every_file_and_allows_native_extras(self):
        web_dir = self.archive.parent / "dist"
        files = compiled_web(web_dir, b"asset fixture")
        for name, content in files.items(): self.put("public/" + name, content)
        result = self.verify(web_dir=web_dir)
        self.assertEqual(result["webPayload"], {"fileCount": len(files),
            "indexSHA256": hashlib.sha256(b"asset fixture").hexdigest(), "byteIdentical": True})

    def test_rejects_missing_changed_or_extra_bytes_in_compiled_web(self):
        web_dir = self.archive.parent / "dist"
        files = compiled_web(web_dir, b"asset fixture")
        for name, content in files.items(): self.put("public/" + name, content)
        asset = self.app / "public/assets/client.js"
        asset.unlink()
        with self.assertRaisesRegex(ValueError, "Missing packaged web asset: assets/client.js"):
            self.verify(web_dir=web_dir)
        for replacement in [b"compiled-v2", b"compiled-v", b"compiled-v1extra"]:
            with self.subTest(replacement=replacement), self.assertRaisesRegex(ValueError, "differs from compiled source: assets/client.js"):
                asset.write_bytes(replacement)
                self.verify(web_dir=web_dir)

    def test_rejects_invalid_source_web_directory_instead_of_vacuous_success(self):
        web_dir = self.archive.parent / "dist"
        with self.assertRaisesRegex(ValueError, "directory is unavailable"):
            self.verify(web_dir=web_dir)
        web_dir.mkdir()
        with self.assertRaisesRegex(ValueError, "missing index.html"):
            self.verify(web_dir=web_dir)
        compiled_web(web_dir, b"asset fixture")
        (web_dir / "linked.js").symlink_to(self.app / "App")
        with self.assertRaisesRegex(ValueError, "contains a symlink"):
            self.verify(web_dir=web_dir)

    def test_device_archive_verifies_transitive_frameworks_and_equivalent_minimum_version(self):
        for minos in ["16.4", "16.4.0"]:
            with self.subTest(minos=minos):
                result = self.verify(minos=minos)
                self.assertEqual(len(result["binaries"]), 3)
                self.assertEqual(len(result["appPayloadSHA256"]), 64)

    def test_rejects_release_identity_drift(self):
        for key in ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion", "MinimumOSVersion"]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "Unexpected release"):
                self.put("Info.plist", plistlib.dumps({**self.info, key: "wrong"}))
                self.verify()
        self.put("Info.plist", plistlib.dumps(self.info))

    def test_rejects_missing_assets_and_embedded_models(self):
        (self.app / "public/preview-isolation.js").unlink()
        with self.assertRaisesRegex(ValueError, "Missing release asset"):
            self.verify()
        self.put("public/preview-isolation.js", b"guard")
        self.put("model.gguf", b"model")
        with self.assertRaisesRegex(ValueError, "model or test fixture"):
            self.verify()

    def test_rejects_symlink_payloads(self):
        (self.app / "unexpected").symlink_to(self.app / "App")
        with self.assertRaisesRegex(ValueError, "Unexpected symlink"):
            self.verify()

    def test_rejects_wrong_architecture_simulator_and_newer_embedded_minimum(self):
        for kwargs, message in [({"arch": "arm64 x86_64"}, "Unexpected release architecture"),
                                ({"platform": "IOSSIMULATOR"}, "non-device"),
                                ({"minos": "16.4.1"}, "newer OS")]:
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(ValueError, message):
                self.verify(**kwargs)

    def test_rejects_missing_transitive_dependency(self):
        with self.assertRaisesRegex(ValueError, "dependency is not packaged"):
            self.verify(dependency="@rpath/Missing.framework/Missing")


if __name__ == "__main__":
    unittest.main()
