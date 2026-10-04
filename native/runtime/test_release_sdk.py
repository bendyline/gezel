import importlib.util
import io
import json
from pathlib import Path
import plistlib
import shutil
import tarfile
import tempfile
import unittest
import zipfile


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load('release_sdk', 'release-sdk.py')
stage = load('stage_sdk', 'stage-sdk.py')
VERSION = '0.1.99'
COMMIT = 'a' * 40
LICENSE_ROOT = Path(__file__).resolve().parents[1] / 'licenses'
NOTICES = json.loads((LICENSE_ROOT / 'manifest.json').read_text())['engines']['llama-cpp']


def write(root, name, data):
    file = root / name
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(data if isinstance(data, bytes) else data.encode())


def zip_bytes(files):
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as bundle:
        for name, content in files.items():
            bundle.writestr(name, content)
    return data.getvalue()


def inventory(root, target, scope='provider-model-runtime'):
    manifest = {'schemaVersion': 1, 'scope': scope, 'target': target,
                'packageVersion': VERSION, 'gezelABIVersion': 1,
                'files': {file.relative_to(root).as_posix(): release.digest(file)
                          for file in root.rglob('*') if file.is_file() and file.name != 'sdk-manifest.json'}}
    write(root, 'sdk-manifest.json', json.dumps(manifest))


def ios_sdk(root):
    engine = root / 'engine'
    prefix = 'swift/GezelLlama/'
    libraries = []
    for variant in ('ios-arm64', 'ios-arm64-simulator'):
        library = {'LibraryIdentifier': variant, 'LibraryPath': 'libGezelLlama.a', 'SupportedPlatform': 'ios'}
        if variant.endswith('simulator'):
            library['SupportedPlatformVariant'] = 'simulator'
        libraries.append(library)
        write(engine, prefix + f'GezelLlama.xcframework/{variant}/libGezelLlama.a', 'fixture static lib')
    write(engine, prefix + 'GezelLlama.xcframework/Info.plist', plistlib.dumps({'AvailableLibraries': libraries}))
    for license in ('gezel', 'llama-cpp', 'ggml'):
        write(engine, prefix + f'LICENSE-{license}.txt', 'fixture MIT notice')
    write(engine, 'runtime-manifest.json', json.dumps({'settings': {'minimumOS': '16.4'}, 'upstream': NOTICES}))
    inventory(engine, 'ios', 'low-level-text-runtime')
    output = root / 'sdk'
    stage.stage('ios', engine, output, Path('/unused'))
    return output


def android_sdk(root):
    sdk = root / 'sdk'
    for name in release.COMMON - {'sdk-manifest.json'}:
        write(sdk, name, 'fixture')
    write(sdk, 'engine-manifest.json', json.dumps({'upstream': NOTICES}))
    write(sdk, 'THIRD_PARTY_LICENSES/manifest.json', json.dumps(NOTICES))
    for name in NOTICES['files']:
        shutil.copyfile(LICENSE_ROOT / name, sdk / 'THIRD_PARTY_LICENSES' / name)
    for artifact in ('gezel-llama', 'gezel-runtime'):
        base = f'maven/com/bendyline/gezel/{artifact}/{VERSION}/{artifact}-{VERSION}'
        files = {'classes.jar': zip_bytes({'com/bendyline/gezel/runtime/NativeCall.class': b'fixture'}),
                 'AndroidManifest.xml': b'fixture'}
        if artifact == 'gezel-llama':
            files.update({f'META-INF/{name}.txt': b'fixture license' for name in (
                'LICENSE-gezel', 'LICENSE-llama-cpp', 'LICENSE-ggml', 'NOTICE-android-ndk', 'NOTICE-android-toolchain')})
        write(sdk, base + '.aar', zip_bytes(files))
        write(sdk, base + '.pom', '<project/>')
    inventory(sdk, 'android')
    return sdk


class PublicSdkTests(unittest.TestCase):
    def test_release_and_ci_versions(self):
        self.assertEqual(VERSION, release.ci_version({'GITHUB_REF': f'refs/tags/native-v{VERSION}'}))
        for ref in ('refs/heads/main', 'refs/pull/1/merge'):
            self.assertEqual('0.0.0-ci.123.2', release.ci_version({
                'GITHUB_REF': ref, 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '2'}))
        for tag in ('oops', '1.2', '1.2.3-rc.1', '01.2.3'):
            with self.assertRaises(ValueError):
                release.ci_version({'GITHUB_REF': f'refs/tags/native-v{tag}'})

    def test_both_sdk_formats_roundtrip_with_matching_release_identity(self):
        for target, fixture in (('ios', ios_sdk), ('android', android_sdk)):
            with self.subTest(target=target), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                sdk = fixture(root)
                archive = release.pack(sdk, root / 'release', target, VERSION, COMMIT)
                release.verify(archive, target, VERSION, COMMIT)
                self.assertIn(release.digest(archive), archive.with_name(archive.name + '.sha256').read_text())
                with self.assertRaisesRegex(ValueError, 'provenance'):
                    release.verify(archive, target, VERSION, 'b' * 40)
                with self.assertRaises(ValueError):
                    release.verify(archive, target, '0.1.98', COMMIT)
                with self.assertRaisesRegex(ValueError, 'immutable'):
                    release.pack(sdk, root / 'release', target, VERSION, COMMIT)

    def test_staging_preserves_both_privacy_bundles_and_license_guide(self):
        with tempfile.TemporaryDirectory() as directory:
            sdk = ios_sdk(Path(directory))
            self.assertEqual(2, (sdk / 'Package.swift').read_text().count('.copy("PrivacyInfo.xcprivacy")'))
            for module in ('GezelRuntime', 'GezelModelStorage'):
                privacy = plistlib.loads((sdk / f'Sources/{module}/PrivacyInfo.xcprivacy').read_bytes())
                self.assertFalse(privacy['NSPrivacyTracking'])
                self.assertTrue(privacy['NSPrivacyAccessedAPITypes'])
            self.assertIn('ML Kit', (sdk / 'PUBLIC-DISTRIBUTION.md').read_text())

    def test_modified_payload_and_extra_uninventoried_file_fail(self):
        for name in ('LICENSE-gezel.txt', 'Sources/GezelRuntime/Extra.swift'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                sdk = ios_sdk(Path(directory))
                write(sdk, name, 'changed')
                with self.assertRaisesRegex(ValueError, 'inventory/hash'):
                    release.verify_sdk(sdk, 'ios', VERSION)

    def test_apps_keys_weights_and_wrong_maven_versions_are_never_sdk_files(self):
        for target, name in (('ios', 'Gezel.xcarchive/Info.plist'), ('ios', 'signing.p12'),
                             ('ios', 'Sources/GezelRuntime/model.gguf'), ('ios', 'embedded.mobileprovision'),
                             ('android', 'app-release.aab'), ('android', 'upload.jks'),
                             ('android', 'maven/com/bendyline/gezel/gezel-runtime/9.9.9/gezel-runtime-9.9.9.aar')):
            self.assertFalse(release.allowed_file(name, target, VERSION), name)

    def test_nested_aar_and_jar_cannot_hide_app_secrets_or_google_sdk(self):
        for name in ('assets/model.gguf', 'signing.p12', 'embedded.mobileprovision'):
            with self.assertRaisesRegex(ValueError, 'Unexpected'):
                release.verify_zip(zip_bytes({'classes.jar': zip_bytes({}), 'AndroidManifest.xml': '', name: ''}))
        with self.assertRaisesRegex(ValueError, 'Unexpected'):
            release.verify_zip(zip_bytes({'com/google/mlkit/Model.class': ''}), classes=True)

    def test_sdk_symlinks_are_rejected_even_with_valid_inventory_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            sdk = ios_sdk(Path(directory))
            file = sdk / 'LICENSE-gezel.txt'
            file.unlink()
            file.symlink_to(sdk / 'LICENSE-ggml.txt')
            inventory(sdk, 'ios')
            with self.assertRaisesRegex(ValueError, 'symlinks'):
                release.verify_sdk(sdk, 'ios', VERSION)

    def test_tar_traversal_links_and_unexpected_payloads_fail(self):
        for name, kind in (('../outside', tarfile.REGTYPE), ('/absolute', tarfile.REGTYPE),
                           ('LICENSE-gezel.txt', tarfile.SYMTYPE), ('app.ipa', tarfile.REGTYPE)):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                archive = Path(directory) / 'bad.tar.gz'
                with tarfile.open(archive, 'w:gz') as bundle:
                    entry = tarfile.TarInfo(name)
                    entry.type = kind
                    entry.linkname = '/tmp/outside'
                    bundle.addfile(entry, io.BytesIO())
                with self.assertRaises(ValueError):
                    release.verify(archive, 'ios', VERSION, COMMIT)

    def test_missing_privacy_resources_fail_even_if_inventory_is_updated(self):
        with tempfile.TemporaryDirectory() as directory:
            sdk = ios_sdk(Path(directory))
            package = sdk / 'Package.swift'
            package.write_text(package.read_text().replace('.copy("PrivacyInfo.xcprivacy")', ''))
            inventory(sdk, 'ios')
            with self.assertRaisesRegex(ValueError, 'privacy resource'):
                release.verify_sdk(sdk, 'ios', VERSION)

    def test_missing_transitive_notice_or_mismatched_license_pin_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            sdk = ios_sdk(Path(directory))
            notice = sdk / 'THIRD_PARTY_LICENSES/LICENSE-nlohmann-json-MIT.txt'
            notice.unlink()
            inventory(sdk, 'ios')
            with self.assertRaisesRegex(ValueError, 'Incomplete public SDK'):
                release.verify_sdk(sdk, 'ios', VERSION)
            engine = sdk / 'engine-manifest.json'
            engine.write_text(json.dumps({'upstream': {'commit': 'b' * 40, 'tag': 'wrong'}}))
            inventory(sdk, 'ios')
            with self.assertRaisesRegex(ValueError, 'license provenance'):
                release.verify_sdk(sdk, 'ios', VERSION)


if __name__ == '__main__':
    unittest.main()
