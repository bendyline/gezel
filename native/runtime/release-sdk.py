#!/usr/bin/env python3
"""Package and verify public mobile SDKs without app archives or signing material."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import re
import shutil
import stat
import tarfile
import tempfile
import zipfile

VERSION = r'(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?'
COMMON = {'sdk-manifest.json', 'engine-manifest.json', 'PUBLIC-DISTRIBUTION.md', 'LICENSE-gezel.txt'}
MAX_BYTES = 2 * 1024 ** 3


def digest(path):
    with path.open('rb') as stream:
        result = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def identity(version, commit):
    if not re.fullmatch(VERSION, version) or not re.fullmatch(r'[0-9a-f]{40}', commit):
        raise ValueError('Expected a package version and full source commit')


def ci_version(env):
    ref = env.get('GITHUB_REF', '')
    if ref.startswith('refs/tags/native-v'):
        version = ref.removeprefix('refs/tags/native-v')
        if not re.fullmatch(r'(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)', version):
            raise ValueError('Native release tags must be native-vX.Y.Z')
        return version
    run, attempt = env.get('GITHUB_RUN_ID', ''), env.get('GITHUB_RUN_ATTEMPT', '')
    if not run.isdecimal() or not attempt.isdecimal():
        raise ValueError('CI builds require GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT')
    return f'0.0.0-ci.{run}.{attempt}'


def safe_name(name):
    path = PurePosixPath(name)
    if not name or path.is_absolute() or '\\' in name or any(p in ('', '.', '..') for p in name.split('/')):
        raise ValueError(f'Unsafe package path: {name}')


def allowed_file(name, target, version):
    safe_name(name)
    if name in COMMON:
        return True
    if re.fullmatch(r'THIRD_PARTY_LICENSES/(manifest\.json|LICENSE-[A-Za-z0-9_.-]+\.txt)', name):
        return True
    if target == 'ios':
        return name in {'Package.swift', 'LICENSE-llama-cpp.txt', 'LICENSE-ggml.txt'} or bool(re.fullmatch(
            r'Sources/(GezelRuntime|GezelModelStorage)/([A-Za-z0-9_]+\.swift|PrivacyInfo\.xcprivacy)'
            r'|GezelLlama\.xcframework/(Info\.plist|ios-[a-z0-9_-]+/(libGezelLlama\.a|Headers/(gezel_llama\.h|module\.modulemap)))', name))
    artifact = r'gezel-(?:llama|runtime)'
    return bool(re.fullmatch(
        rf'maven/com/bendyline/gezel/(?P<artifact>{artifact})/'
        rf'(maven-metadata\.xml|{re.escape(version)}/(?P=artifact)-{re.escape(version)}'
        rf'(\.aar|\.pom|\.module|-sources\.jar))(\.(md5|sha1|sha256|sha512))?', name))


def verify_zip(data, sources=False, classes=False):
    """AARs contain our libraries; Google SDKs remain Maven dependencies."""
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        seen, total = set(), 0
        for member in archive.infolist():
            name = member.filename.rstrip('/')
            safe_name(name)
            if name in seen or stat.S_ISLNK(member.external_attr >> 16):
                raise ValueError(f'Unsafe ZIP entry: {name}')
            seen.add(name)
            if member.is_dir():
                continue
            total += member.file_size
            if total > MAX_BYTES:
                raise ValueError('SDK ZIP exceeds size limit')
            if sources or classes:
                allowed = name == 'META-INF/MANIFEST.MF' or bool(re.fullmatch(
                    r'com/bendyline/gezel/(runtime|llama)/[A-Za-z0-9_$]+\.' + ('java' if sources else 'class'), name))
            else:
                allowed = name in {'AndroidManifest.xml', 'R.txt', 'proguard.txt', 'classes.jar',
                    'META-INF/com/android/build/gradle/aar-metadata.properties',
                    'META-INF/gezel-runtime-manifest.json', 'META-INF/LICENSE-gezel.txt',
                    'META-INF/LICENSE-llama-cpp.txt', 'META-INF/LICENSE-ggml.txt',
                    'META-INF/NOTICE-android-ndk.txt', 'META-INF/NOTICE-android-toolchain.txt'} or bool(re.fullmatch(
                        r'jni/(arm64-v8a|x86_64)/lib(?:gezel[-_][A-Za-z0-9_-]+|llama|ggml[A-Za-z0-9_.-]*|c\+\+_shared)\.so', name))
            if not allowed:
                raise ValueError(f'Unexpected public SDK ZIP content: {name}')
            if name == 'classes.jar':
                verify_zip(archive.read(member), classes=True)
        if not sources and not classes:
            if not {'classes.jar', 'AndroidManifest.xml'} <= seen:
                raise ValueError('Incomplete Android library')
        return seen


def verify_sdk(root, target, version):
    manifest = json.loads((root / 'sdk-manifest.json').read_text())
    if (manifest.get('schemaVersion'), manifest.get('scope'), manifest.get('target'),
            manifest.get('packageVersion'), manifest.get('gezelABIVersion')) != (
            1, 'provider-model-runtime', target, version, 1):
        raise ValueError('SDK identity/version mismatch')
    files = {}
    for file in sorted(root.rglob('*')):
        if file.is_symlink():
            raise ValueError('SDK symlinks are not distributable')
        if file.is_file():
            name = file.relative_to(root).as_posix()
            if not allowed_file(name, target, version):
                raise ValueError(f'Unexpected public SDK file: {name}')
            files[name] = digest(file)
    if {name: sha for name, sha in files.items() if name != 'sdk-manifest.json'} != manifest.get('files'):
        raise ValueError('SDK inventory/hash mismatch')
    required = set(COMMON)
    notices = json.loads((root / 'THIRD_PARTY_LICENSES/manifest.json').read_text())
    upstream = json.loads((root / 'engine-manifest.json').read_text()).get('upstream', {})
    if not notices.get('files') or any(upstream.get(key) != notices.get(key) for key in ('tag', 'commit')):
        raise ValueError('Engine license provenance mismatch')
    required.add('THIRD_PARTY_LICENSES/manifest.json')
    required.update(f'THIRD_PARTY_LICENSES/{name}' for name in notices['files'])
    if target == 'ios':
        required |= {'Package.swift', 'LICENSE-llama-cpp.txt', 'LICENSE-ggml.txt', 'GezelLlama.xcframework/Info.plist'}
        for module in ('GezelRuntime', 'GezelModelStorage'):
            name = f'Sources/{module}/PrivacyInfo.xcprivacy'
            required.add(name)
            privacy = plistlib.loads((root / name).read_bytes())
            if not isinstance(privacy.get('NSPrivacyAccessedAPITypes'), list):
                raise ValueError('Missing SDK required-reason declarations')
        package = (root / 'Package.swift').read_text()
        if package.count('.copy("PrivacyInfo.xcprivacy")') != 2:
            raise ValueError('Swift package must preserve both privacy resource bundles')
        libraries = plistlib.loads((root / 'GezelLlama.xcframework/Info.plist').read_bytes())['AvailableLibraries']
        variants = set()
        for library in libraries:
            variants.add(library.get('SupportedPlatformVariant', 'device'))
            required.add(f'GezelLlama.xcframework/{library["LibraryIdentifier"]}/{library["LibraryPath"]}')
        if not {'device', 'simulator'} <= variants:
            raise ValueError('iOS SDK requires device and simulator slices')
    else:
        for artifact in ('gezel-llama', 'gezel-runtime'):
            base = f'maven/com/bendyline/gezel/{artifact}/{version}/{artifact}-{version}'
            required |= {base + '.aar', base + '.pom'}
            entries = verify_zip((root / (base + '.aar')).read_bytes())
            if artifact == 'gezel-llama' and not {
                'META-INF/LICENSE-llama-cpp.txt', 'META-INF/LICENSE-ggml.txt',
                'META-INF/LICENSE-gezel.txt', 'META-INF/NOTICE-android-ndk.txt',
                'META-INF/NOTICE-android-toolchain.txt'} <= entries:
                raise ValueError('Android engine is missing license notices')
        for name in files:
            if name.endswith('-sources.jar'):
                verify_zip((root / name).read_bytes(), sources=True)
    if not required <= files.keys():
        raise ValueError(f'Incomplete public SDK: {sorted(required - files.keys())}')
    return files


def verify(archive, target, version, commit):
    identity(version, commit)
    with tempfile.TemporaryDirectory(prefix='gezel-sdk-verify-') as directory:
        root = Path(directory)
        seen, total = set(), 0
        with tarfile.open(archive, 'r:gz') as bundle:
            for member in bundle:
                safe_name(member.name)
                total += member.size
                if not member.isfile() or member.name in seen or total > MAX_BYTES:
                    raise ValueError('Unsafe SDK archive entry or oversized archive')
                seen.add(member.name)
                if member.name != 'release-manifest.json' and not allowed_file(member.name, target, version):
                    raise ValueError(f'Unexpected public SDK file: {member.name}')
                file = root / member.name
                file.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, file.open('wb') as destination:
                    shutil.copyfileobj(source, destination)
        release_file = root / 'release-manifest.json'
        release = json.loads(release_file.read_text())
        release_file.unlink()
        if release != {'schemaVersion': 1, 'target': target, 'version': version, 'sourceCommit': commit,
                       'librarySigning': 'unsigned', 'files': verify_sdk(root, target, version)}:
            raise ValueError('Release provenance/inventory mismatch')


def pack(sdk, output, target, version, commit):
    identity(version, commit)
    files = verify_sdk(sdk, target, version)
    metadata = {'schemaVersion': 1, 'target': target, 'version': version, 'sourceCommit': commit,
                'librarySigning': 'unsigned', 'files': files}
    output.mkdir(parents=True, exist_ok=True)
    archive = output / f'gezel-mobile-{version}-{target}.tar.gz'
    if archive.exists():
        raise ValueError('Release archives are immutable; choose a new output directory')
    with tempfile.TemporaryDirectory(prefix='.gezel-release-', dir=output) as directory:
        temporary = Path(directory) / archive.name
        with tarfile.open(temporary, 'w:gz') as bundle:
            for name in sorted(files):
                info = bundle.gettarinfo(sdk / name, arcname=name)
                info.uid = info.gid = info.mtime = 0
                info.uname = info.gname = ''
                info.mode = 0o644
                with (sdk / name).open('rb') as stream:
                    bundle.addfile(info, stream)
            data = (json.dumps(metadata, indent=2) + '\n').encode()
            info = tarfile.TarInfo('release-manifest.json')
            info.size = len(data)
            info.mode = 0o644
            bundle.addfile(info, io.BytesIO(data))
        verify(temporary, target, version, commit)
        temporary.rename(archive)
    archive.with_name(archive.name + '.sha256').write_text(f'{digest(archive)}  {archive.name}\n')
    return archive


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('version')
    packing = commands.add_parser('pack')
    packing.add_argument('target', choices=('ios', 'android'))
    packing.add_argument('--sdk', type=Path, required=True)
    packing.add_argument('--output', type=Path, required=True)
    checking = commands.add_parser('verify')
    checking.add_argument('archive', type=Path)
    checking.add_argument('--target', choices=('ios', 'android'), required=True)
    for command in (packing, checking):
        command.add_argument('--version', required=True)
        command.add_argument('--commit', required=True)
    args = parser.parse_args()
    if args.command == 'version':
        print(f'version={ci_version(os.environ)}')
    elif args.command == 'pack':
        print(pack(args.sdk, args.output, args.target, args.version, args.commit))
    else:
        verify(args.archive, args.target, args.version, args.commit)
        print(f'Verified public {args.target} SDK {args.version}')
