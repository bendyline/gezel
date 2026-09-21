#!/usr/bin/env python3
"""Build isolated speech libraries from verified inputs; fetch only with --fetch."""
import argparse
import hashlib
import json
import os
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

def source(name, fetch):
    pin = PINS[name]
    path = CACHE / pin['file']
    if not path.is_file():
        if not fetch: raise ValueError('Missing ' + name + '; run with --fetch after approving dependencies.')
        CACHE.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + '.partial')
        subprocess.run(['curl', '-fL', '--retry', '2', pin['url'], '-o', str(temporary)], check=True)
        if digest(temporary) != pin['sha256']: raise ValueError('Checksum mismatch: ' + name)
        temporary.replace(path)
    if digest(path) != pin['sha256']: raise ValueError('Checksum mismatch: ' + name)
    return path

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
    args = parser.parse_args()
    output = HERE.parent / '.build' / ('speech-' + args.platform)
    staging = output / 'verified'
    staging.mkdir(parents=True, exist_ok=True)
    for name in ['whisper-source', 'sherpa-source', 'sherpa-' + args.platform] + (['onnx-ios'] if args.platform == 'ios' else []):
        archive = source(name, args.fetch)
        destination = staging / name
        if destination.exists(): shutil.rmtree(destination)
        extract(archive, destination)
    whisper = next((staging / 'whisper-source').glob('whisper.cpp-*'))
    sherpa = next((staging / 'sherpa-source').glob('sherpa-onnx-*'))
    common = ['-DCMAKE_BUILD_TYPE=Release', '-DGEZEL_WHISPER_SOURCE=' + str(whisper),
              '-DGEZEL_SHERPA_HEADERS=' + str(sherpa), '-DGGML_ACCELERATE=' + ('ON' if args.platform == 'ios' else 'OFF')]
    payload = output / 'payload'
    if payload.exists(): shutil.rmtree(payload)
    payload.mkdir()
    if args.platform == 'android':
        if not args.ndk: raise ValueError('--ndk or ANDROID_NDK_HOME is required')
        ndk = Path(args.ndk)
        libraries = staging / 'sherpa-android/jniLibs/arm64-v8a'
        build = output / 'build'
        flags = [*common, '-DCMAKE_TOOLCHAIN_FILE=' + str(ndk / 'build/cmake/android.toolchain.cmake'),
                 '-DANDROID_ABI=arm64-v8a', '-DANDROID_PLATFORM=android-28', '-DANDROID_STL=c++_shared',
                 '-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON',
                 '-DGEZEL_SHERPA_LIBRARY=' + str(libraries / 'libsherpa-onnx-c-api.so'),
                 '-DGEZEL_ONNX_LIBRARY=' + str(libraries / 'libonnxruntime.so')]
        run(['cmake', '-S', HERE, '-B', build, *flags])
        run(['cmake', '--build', build, '--target', 'GezelSpeech', '--parallel', '4'])
        for file in [build / 'libGezelSpeech.so', libraries / 'libsherpa-onnx-c-api.so', libraries / 'libonnxruntime.so']:
            shutil.copy2(file, payload)
        readelf = next((ndk / 'toolchains/llvm/prebuilt').glob('*/bin/llvm-readelf'))
        for library in payload.glob('*.so'):
            info = subprocess.check_output([str(readelf), '-lW', str(library)], text=True)
            if any(int(line.split()[-1], 16) < 16384 for line in info.splitlines() if line.strip().startswith('LOAD ')):
                raise ValueError('Speech library is not 16 KB aligned: ' + library.name)
    else:
        frameworks = []
        for sdk, slice_name in [('iphoneos', 'ios-arm64'), ('iphonesimulator', 'ios-arm64_x86_64-simulator')]:
            build = output / sdk
            sherpa_lib = staging / 'sherpa-ios/sherpa-onnx.xcframework' / slice_name / 'SherpaOnnxC.framework/SherpaOnnxC'
            onnx_lib = staging / 'onnx-ios/onnxruntime.xcframework' / slice_name / 'onnxruntime.framework/onnxruntime'
            run(['cmake', '-S', HERE, '-B', build, *common, '-DCMAKE_SYSTEM_NAME=iOS',
                 '-DCMAKE_OSX_SYSROOT=' + sdk, '-DCMAKE_OSX_ARCHITECTURES=arm64', '-DCMAKE_OSX_DEPLOYMENT_TARGET=16.4',
                 '-DGEZEL_SHERPA_LIBRARY=' + str(sherpa_lib), '-DGEZEL_ONNX_LIBRARY=' + str(onnx_lib)])
            run(['cmake', '--build', build, '--target', 'GezelSpeech', '--parallel', '4'])
            framework = build / 'GezelSpeech.framework'
            headers = framework / 'Headers'; headers.mkdir(exist_ok=True)
            shutil.copy2(HERE / 'gezel_speech.h', headers)
            modules = framework / 'Modules'; modules.mkdir(exist_ok=True)
            (modules / 'module.modulemap').write_text('framework module GezelSpeech { umbrella header "gezel_speech.h" export * }\n')
            frameworks.extend(['-framework', framework])
        run(['xcodebuild', '-create-xcframework', *frameworks, '-output', payload / 'GezelSpeech.xcframework'])
    shutil.copy2(whisper / 'LICENSE', payload / 'LICENSE-whisper.txt')
    shutil.copy2(sherpa / 'LICENSE', payload / 'LICENSE-sherpa-onnx.txt')
    for notice in (HERE / 'licenses').glob('*.txt'):
        shutil.copy2(notice, payload / notice.name)
    if args.models:
        models = payload / 'models'; models.mkdir()
        shutil.copy2(source('whisper-model', args.fetch), models / 'whisper-tiny.bin')
        extract(source('kokoro-model', args.fetch), models)
        (models / 'kokoro-int8-multi-lang-v1_0').rename(models / 'kokoro')
    manifest = {'pins': PINS, 'bridge': {str(file.relative_to(HERE)): digest(file) for file in HERE.rglob('*') if file.suffix in ['.h', '.cpp', '.txt', '.py', '.json']},
                'files': {str(file.relative_to(payload)): digest(file) for file in payload.rglob('*') if file.is_file()}}
    (payload / 'speech-build.json').write_text(json.dumps(manifest, indent=2) + '\n')

if __name__ == '__main__': main()
