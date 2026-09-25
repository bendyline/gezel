#!/usr/bin/env python3
"""Stage self-contained provider/model hosts over a verified low-level SDK.

Does not compile llama.cpp. Android compiles only the Java host and publishes it
to the output's folder Maven repository; Swift clients compile the Swift host.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def verified_sdk(source, target):
    manifest = json.loads((source / 'sdk-manifest.json').read_text())
    if manifest.get('scope') != 'low-level-text-runtime' or manifest.get('target') != target:
        raise ValueError('Expected a staged low-level SDK for this platform')
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', manifest.get('packageVersion', '')):
        raise ValueError('Invalid SDK version')
    if manifest.get('gezelABIVersion') != 1 or not manifest.get('files'):
        raise ValueError('Unsupported SDK ABI or missing inventory')
    for name, sha in manifest['files'].items():
        file = source / name
        if file.is_symlink() or source not in file.resolve().parents or digest(file) != sha:
            raise ValueError(f'SDK integrity mismatch: {name}')
    return manifest


def copy_inventory(source, destination, manifest, prefix, replacement):
    for name in manifest['files']:
        if name.startswith(prefix):
            file = destination / (replacement + name[len(prefix):])
            file.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, file)


def stage(target, sdk, output, gradle, offline=False):
    sdk, output = sdk.resolve(), output.resolve()
    manifest = verified_sdk(sdk, target)
    if output.exists():
        raise ValueError('Choose a new output directory; staged versions are immutable')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.gezel-host-', dir=output.parent) as directory:
        work = Path(directory)
        staged = work / 'staged'
        staged.mkdir()
        if target == 'ios':
            copy_inventory(sdk, staged, manifest, 'swift/GezelLlama/GezelLlama.xcframework/', 'GezelLlama.xcframework/')
            for name in ('GezelRuntime', 'GezelModelStorage'):
                source = HERE / ('ios' if name == 'GezelRuntime' else 'models') / 'Sources' / name
                shutil.copytree(source, staged / 'Sources' / name)
            runtime = json.loads((sdk / 'runtime-manifest.json').read_text())
            minimum = runtime['settings']['minimumOS']
            if not re.fullmatch(r'\d+\.\d+', minimum):
                raise ValueError('Invalid iOS deployment target')
            (staged / 'Package.swift').write_text(f'''// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "GezelRuntime",
    platforms: [.iOS("{minimum}")],
    products: [
        .library(name: "GezelRuntime", targets: ["GezelRuntime"]),
        .library(name: "GezelModelStorage", targets: ["GezelModelStorage"])
    ],
    targets: [
        .binaryTarget(name: "GezelLlama", path: "GezelLlama.xcframework"),
        .target(name: "GezelModelStorage"),
        .target(name: "GezelRuntime", dependencies: ["GezelLlama", "GezelModelStorage"])
    ],
    swiftLanguageModes: [.v5]
)
''')
            for name in manifest['files']:
                if name.startswith('swift/GezelLlama/LICENSE'):
                    shutil.copyfile(sdk / name, staged / Path(name).name)
        else:
            copy_inventory(sdk, staged, manifest, 'maven/', 'maven/')
            command = [str(gradle.resolve()), '-p', str(HERE / 'android'), '--no-daemon',
                       f'-PgezelMavenRepository={staged / "maven"}',
                       f'-PgezelVersion={manifest["packageVersion"]}', 'assembleRelease', 'publish']
            if offline:
                command.append('--offline')
            subprocess.run(command, check=True)
            shutil.copyfile(REPO / 'LICENSE', staged / 'LICENSE-gezel.txt')
        shutil.copyfile(sdk / 'runtime-manifest.json', staged / 'engine-manifest.json')
        sources = [file for folder in ('android/src', 'ios/Sources', 'models/Sources')
                   for file in (HERE / folder).rglob('*') if file.is_file()]
        sources += [HERE / 'android/build.gradle', Path(__file__).resolve()]
        metadata = {
            'schemaVersion': 1, 'scope': 'provider-model-runtime', 'target': target,
            'packageVersion': manifest['packageVersion'], 'gezelABIVersion': manifest['gezelABIVersion'],
            'deviceInference': 'not-run',
            'sources': {str(file.relative_to(REPO)): digest(file) for file in sorted(sources)},
            'files': {str(file.relative_to(staged)): digest(file) for file in sorted(staged.rglob('*')) if file.is_file()},
        }
        (staged / 'sdk-manifest.json').write_text(json.dumps(metadata, indent=2) + '\n')
        staged.rename(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target', choices=('ios', 'android'))
    parser.add_argument('--sdk', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--gradle', type=Path, default=REPO / 'packages/mobile/android/gradlew')
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    stage(args.target, args.sdk, args.output, args.gradle, args.offline)
    print(f'Staged {args.target} provider/model runtime at {args.output}')
