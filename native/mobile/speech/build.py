#!/usr/bin/env python3
"""Build isolated speech libraries from verified inputs; fetch only with --fetch."""
import argparse
import hashlib
import io
import json
import os
import re
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import zipfile

HERE = Path(__file__).resolve().parent
CACHE = HERE.parent / '.build/speech-deps'
PINS = json.loads((HERE / 'pins.json').read_text())

def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''): value.update(block)
    return value.hexdigest()

def verified(url, path, sha256, name, fetch):
    if not path.is_file():
        if not fetch: raise ValueError('Missing ' + name + '; run with --fetch after approving dependencies.')
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + '.partial')
        subprocess.run(['curl', '-fL', '--retry', '2', url, '-o', str(temporary)], check=True)
        if digest(temporary) != sha256: raise ValueError('Checksum mismatch: ' + name)
        temporary.replace(path)
    if digest(path) != sha256: raise ValueError('Checksum mismatch: ' + name)
    return path

def source(name, fetch):
    pin = PINS[name]
    return verified(pin['url'], CACHE / pin['file'], pin['sha256'], name, fetch)

def source_files(name, fetch):
    # Loose files at a fixed upstream revision. A release tag can be re-uploaded
    # under the same URL (sherpa-onnx's tts-models was, 2026-10-26); a commit
    # URL always serves the same bytes or nothing.
    pin = PINS[name]
    files = {}
    for file, sha256 in pin['files'].items():
        relative = PurePosixPath(file)
        if relative.is_absolute() or '..' in relative.parts or '\\' in file: raise ValueError('Unsafe pinned path')
        files[file] = verified(pin['url'] + file, CACHE / pin['dir'] / file, sha256, name + '/' + file, fetch)
    return files

def extract(archive, destination):
    # Only ordinary files: upstream symlinks, devices, and paths outside the
    # destination cannot enter the compiled payload or model package.
    def output(name):
        path = PurePosixPath(name)
        if path.is_absolute() or '..' in path.parts or '\\' in name: raise ValueError('Unsafe archive path')
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        return target
    if archive.suffix == '.zip':
        with zipfile.ZipFile(archive) as packed:
            for member in packed.infolist():
                if member.is_dir(): continue
                if (member.external_attr >> 16) & 0o170000 == 0o120000: continue
                with packed.open(member) as src, output(member.filename).open('wb') as dst: shutil.copyfileobj(src, dst)
    else:
        with tarfile.open(archive) as packed:
            for member in packed:
                if not member.isfile(): continue
                with packed.extractfile(member) as src, output(member.name).open('wb') as dst: shutil.copyfileobj(src, dst)

def run(argv):
    subprocess.run([str(value) for value in argv], check=True)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('platform', choices=['ios', 'android'])
    parser.add_argument('--fetch', action='store_true')
    parser.add_argument('--models', action='store_true', help='Stage the verified offline speech pack for bundling')
    parser.add_argument('--ndk', default=os.environ.get('ANDROID_NDK_HOME'))
    parser.add_argument('--package', metavar='VERSION', help='Also lay out the payload for @bendyline/gezel-capacitor')
    args = parser.parse_args()
    output = HERE.parent / '.build' / ('speech-' + args.platform)
    staging = output / 'verified'
    staging.mkdir(parents=True, exist_ok=True)
    for name in ['whisper-source', 'onnx-' + args.platform]:
        archive = source(name, args.fetch)
        destination = staging / name
        if destination.exists(): shutil.rmtree(destination)
        extract(archive, destination)
    whisper = next((staging / 'whisper-source').glob('whisper.cpp-*'))
    # Kokoro runs on ONNX Runtime directly. sherpa-onnx used to supply it, but
    # its TTS build links eSpeak NG (GPL-3) whether or not anything calls it,
    # and this app must not distribute that. Phonemes now arrive from the
    # shared TypeScript frontend instead.
    onnx_header = next(f for f in (staging / ('onnx-' + args.platform)).rglob('onnxruntime_c_api.h'))
    common = ['-DCMAKE_BUILD_TYPE=Release', '-DGEZEL_WHISPER_SOURCE=' + str(whisper),
              '-DGEZEL_ONNX_HEADERS=' + str(onnx_header.parent),
              '-DGGML_ACCELERATE=' + ('ON' if args.platform == 'ios' else 'OFF')]
    payload = output / 'payload'
    if payload.exists(): shutil.rmtree(payload)
    payload.mkdir()
    if args.platform == 'android':
        if not args.ndk: raise ValueError('--ndk or ANDROID_NDK_HOME is required')
        ndk = Path(args.ndk)
        onnx_so = next(f for f in (staging / 'onnx-android').rglob('libonnxruntime.so')
                       if 'arm64-v8a' in f.parts)
        build = output / 'build'
        flags = [*common, '-DCMAKE_TOOLCHAIN_FILE=' + str(ndk / 'build/cmake/android.toolchain.cmake'),
                 '-DANDROID_ABI=arm64-v8a', '-DANDROID_PLATFORM=android-28', '-DANDROID_STL=c++_shared',
                 '-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON',
                 '-DGEZEL_ONNX_LIBRARY=' + str(onnx_so)]
        run(['cmake', '-S', HERE, '-B', build, *flags])
        run(['cmake', '--build', build, '--target', 'GezelSpeech', '--parallel', '4'])
        for file in [build / 'libGezelSpeech.so', onnx_so]:
            shutil.copy2(file, payload)
        # Symbols are 90% of the unstripped library (15 MB against 1.3 MB).
        strip = next((ndk / 'toolchains/llvm/prebuilt').glob('*/bin/llvm-strip'))
        run([strip, '--strip-unneeded', payload / 'libGezelSpeech.so'])
        readelf = next((ndk / 'toolchains/llvm/prebuilt').glob('*/bin/llvm-readelf'))
        for library in payload.glob('*.so'):
            info = subprocess.check_output([str(readelf), '-lW', str(library)], text=True)
            if any(int(line.split()[-1], 16) < 16384 for line in info.splitlines() if line.strip().startswith('LOAD ')):
                raise ValueError('Speech library is not 16 KB aligned: ' + library.name)
    else:
        frameworks = []
        for sdk, slice_name in [('iphoneos', 'ios-arm64'), ('iphonesimulator', 'ios-arm64_x86_64-simulator')]:
            build = output / sdk
            onnx_lib = staging / 'onnx-ios/onnxruntime.xcframework' / slice_name / 'onnxruntime.framework/onnxruntime'
            run(['cmake', '-S', HERE, '-B', build, *common, '-DCMAKE_SYSTEM_NAME=iOS',
                 '-DCMAKE_OSX_SYSROOT=' + sdk, '-DCMAKE_OSX_ARCHITECTURES=arm64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=16.4',
                 '-DGEZEL_ONNX_LIBRARY=' + str(onnx_lib)])
            run(['cmake', '--build', build, '--target', 'GezelSpeech', '--parallel', '4'])
            framework = build / 'GezelSpeech.framework'
            headers = framework / 'Headers'; headers.mkdir(exist_ok=True)
            shutil.copy2(HERE / 'gezel_speech.h', headers)
            modules = framework / 'Modules'; modules.mkdir(exist_ok=True)
            (modules / 'module.modulemap').write_text('framework module GezelSpeech { umbrella header "gezel_speech.h" export * }\n')
            frameworks.extend(['-framework', framework])
        run(['xcodebuild', '-create-xcframework', *frameworks, '-output', payload / 'GezelSpeech.xcframework'])
    shutil.copy2(whisper / 'LICENSE', payload / 'LICENSE-whisper.txt')
    for notice in (HERE / 'licenses').glob('*.txt'):
        shutil.copy2(notice, payload / notice.name)
    if args.models:
        models = payload / 'models'; models.mkdir()
        shutil.copy2(source('whisper-model', args.fetch), models / 'whisper-tiny.bin')
        # The pin leaves out espeak-ng-data: it is GPL-3 and only the retired
        # eSpeak frontend read it.
        for file, path in source_files('kokoro-model', args.fetch).items():
            target = models / 'kokoro' / file
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)
    manifest = {'pins': PINS, 'bridge': {str(file.relative_to(HERE)): digest(file) for file in HERE.rglob('*') if file.suffix in ['.h', '.cpp', '.txt', '.py', '.json']},
                'files': {str(file.relative_to(payload)): digest(file) for file in payload.rglob('*') if file.is_file()}}
    (payload / 'speech-build.json').write_text(json.dumps(manifest, indent=2) + '\n')
    if args.package:
        package(args.platform, payload, output / 'package', args.package)

ABI = int(next(line.split()[-1] for line in (HERE / 'gezel_speech.h').read_text().splitlines()
               if line.startswith('#define GEZEL_SPEECH_ABI ')))

def archive(output, files):
    """Stable ZIP metadata, as in ../stage-sdk.py: no host timestamps or modes."""
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as result:
        for name, source in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            result.writestr(info, source.read_bytes() if isinstance(source, Path) else source)

def package(platform, payload, output, version):
    """Lay out the payload as @bendyline/gezel-capacitor stages it (native/speech-<platform>)."""
    if not re.fullmatch(r'\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?', version): raise ValueError('Invalid package version')
    if output.exists(): shutil.rmtree(output)
    output.mkdir(parents=True)
    licenses = sorted(file.name for file in payload.glob('*.txt'))
    for name in licenses: shutil.copy2(payload / name, output / name)
    if platform == 'android':
        group = 'com/bendyline/gezel/gezel-speech/' + version
        maven = output / 'maven' / group
        maven.mkdir(parents=True)
        aar = maven / f'gezel-speech-{version}.aar'
        empty = io.BytesIO()
        zipfile.ZipFile(empty, 'w').close()
        files = {
            # AGP expects a classes.jar; the Java binding is plugin source, so this one is empty.
            'classes.jar': empty.getvalue(),
            'R.txt': b'',
            'AndroidManifest.xml': b'<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.bendyline.gezel.speech.runtime"><uses-sdk android:minSdkVersion="28" /></manifest>\n',
            'jni/arm64-v8a/libGezelSpeech.so': payload / 'libGezelSpeech.so',
            'jni/arm64-v8a/libonnxruntime.so': payload / 'libonnxruntime.so',
        }
        for name in licenses: files['META-INF/' + name] = payload / name
        archive(aar, files)
        pom = maven / f'gezel-speech-{version}.pom'
        pom.write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.bendyline.gezel</groupId><artifactId>gezel-speech</artifactId><version>{version}</version>
  <packaging>aar</packaging><name>Gezel offline speech runtime</name>
  <description>Whisper and Kokoro on ONNX Runtime. Loads libc++_shared.so from gezel-llama of the same release.</description>
  <licenses><license><name>MIT</name><url>https://opensource.org/license/mit</url></license></licenses>
</project>
''')
        for artifact in (aar, pom): artifact.with_suffix(artifact.suffix + '.sha256').write_text(digest(artifact) + '\n')
    else:
        shutil.copytree(payload / 'GezelSpeech.xcframework', output / 'GezelSpeech.xcframework', symlinks=True)
    files = {str(file.relative_to(output)): digest(file) for file in sorted(output.rglob('*'))
             if file.is_file() and not file.is_symlink()}
    (output / 'sdk-manifest.json').write_text(json.dumps({
        'scope': 'speech-runtime', 'target': platform, 'speechABIVersion': ABI,
        'packageVersion': version, 'files': files,
    }, indent=2) + '\n')

if __name__ == '__main__': main()
