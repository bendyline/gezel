import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("stage_sdk", Path(__file__).with_name("stage-sdk.py"))
sdk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sdk)


class StageSdkTest(unittest.TestCase):
    def fixture(self, root):
        build = root / "build"
        build.mkdir()
        files = {"GezelLlama.xcframework/Info.plist": "fixture metadata",
                 "GezelLlama.xcframework/ios-arm64/libGezelLlama.a": "fixture library",
                 "GezelLlama.xcframework/ios-arm64/Headers/gezel_llama.h": "fixture public ABI",
                 "GezelLlama.xcframework/ios-arm64/Headers/llama.h": "fixture private upstream",
                 "GezelLlama.xcframework/ios-arm64/Headers/module.modulemap": "fixture upstream module",
                 **{name: "fixture license" for name in sdk.LICENSES}}
        for name, data in files.items():
            path = build / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(data)
        pin = {}
        for line in (sdk.HERE.parent / 'engines/llama-cpp/VERSION').read_text().splitlines():
            if line and not line.startswith('#'):
                key, value = line.split('=', 1)
                pin[key] = value
        manifest = {"schemaVersion": 1, "target": "ios", "gezelABIVersion": 1,
                    "upstream": pin, "patches": [], "verification": {"linkSmoke": "passed"},
                    "bridgeSources": {name: sdk.digest(sdk.HERE / name) for name in
                                      ("gezel_llama.h", "gezel_llama.cpp", "utf8_stream.h", "CMakeLists.txt")},
                    "settings": {"minimumOS": "16.4"},
                    "files": {name: sdk.digest(build / name) for name in files}}
        (build / "manifest.json").write_text(json.dumps(manifest))
        return build

    def test_local_swift_package_is_self_contained_and_hashes_match(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build = self.fixture(root)
            output = root / 'preview'
            sdk.stage('ios', build, output, '0.1.0-local.1')
            package = (output / 'swift/GezelLlama/Package.swift').read_text()
            self.assertIn('path: "GezelLlama.xcframework"', package)
            self.assertNotIn(str(root), package)
            headers = output / 'swift/GezelLlama/GezelLlama.xcframework/ios-arm64/Headers'
            self.assertFalse((headers / 'llama.h').exists())
            self.assertIn('header "gezel_llama.h"', (headers / 'module.modulemap').read_text())
            manifest = json.loads((output / 'sdk-manifest.json').read_text())
            self.assertEqual('not-run', manifest['deviceInference'])
            for name, sha256 in manifest['files'].items():
                self.assertEqual(sha256, sdk.digest(output / name))
            with self.assertRaisesRegex(ValueError, 'immutable'):
                sdk.stage('ios', build, output, '0.1.0-local.1')

    def test_modified_native_payload_never_creates_a_package(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build = self.fixture(root)
            (build / 'GezelLlama.xcframework/ios-arm64/libGezelLlama.a').write_text('changed')
            with self.assertRaises(subprocess.CalledProcessError):
                sdk.stage('ios', build, root / 'preview', '0.1.0-local.1')
            self.assertFalse((root / 'preview').exists())

    def test_package_failure_cleans_up_partial_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            build = self.fixture(root)
            with patch.object(sdk, 'stage_ios', side_effect=ValueError('failed packaging')):
                with self.assertRaisesRegex(ValueError, 'failed packaging'):
                    sdk.stage('ios', build, root / 'preview', '0.1.0-local.1')
            self.assertEqual(['build'], sorted(path.name for path in root.iterdir()))

    def test_android_binding_requires_matching_ndk_and_supported_abi(self):
        with tempfile.TemporaryDirectory() as directory:
            ndk = Path(directory)
            (ndk / 'source.properties').write_text('Pkg.Revision = 28.2.13676358\n')
            manifest = {'settings': {'abis': ['arm64-v8a'], 'minimumAPI': 28},
                        'toolchains': {'ndk': '28.2.13676358'}}
            self.assertEqual((['arm64-v8a'], 28), sdk.android_settings(manifest, ndk))
            for key, value in [('abis', ['armeabi-v7a']), ('minimumAPI', 27), ('abis', ['arm64-v8a', 'arm64-v8a'])]:
                with self.subTest(key=key, value=value):
                    invalid = {**manifest, 'settings': {**manifest['settings'], key: value}}
                    with self.assertRaises(ValueError):
                        sdk.android_settings(invalid, ndk)
            manifest['toolchains']['ndk'] = '29.0.0'
            with self.assertRaisesRegex(ValueError, 'exact NDK'):
                sdk.android_settings(manifest, ndk)

    def test_archives_have_stable_content_and_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first, second = root / 'first.aar', root / 'second.aar'
            sdk.archive(first, {'classes.jar': 'classes', 'R.txt': ''})
            sdk.archive(second, {'R.txt': '', 'classes.jar': 'classes'})
            self.assertEqual(sdk.digest(first), sdk.digest(second))
            with zipfile.ZipFile(first) as artifact:
                self.assertEqual(['R.txt', 'classes.jar'], artifact.namelist())
                self.assertEqual((1980, 1, 1, 0, 0, 0), artifact.getinfo('classes.jar').date_time)


if __name__ == '__main__':
    unittest.main()
