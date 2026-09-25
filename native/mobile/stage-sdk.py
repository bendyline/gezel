#!/usr/bin/env python3
"""Stage a local Swift package or Maven AAR from a verified prebuilt llama runtime.

No engine sources, downloads, package installation, or registry publication.
Android compiles only Gezel's small Java/JNI binding using the runtime's NDK.
"""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
JAVA_CLASS = "com/bendyline/gezel/llama/LlamaRuntime"
ARTIFACT = "gezel-llama"
GROUP = "com.bendyline.gezel"
LICENSES = ("LICENSE-llama-cpp.txt", "LICENSE-ggml.txt")
MODULE_MAP = '''module GezelLlama {
  header "gezel_llama.h"
  link "c++"
  link framework "Accelerate"
  link framework "Foundation"
  link framework "Metal"
  link framework "MetalKit"
  export *
}
'''


def run(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def verify_build(build, target):
    # Keep verification errors visible; stdout is the machine-readable manifest.
    result = run(["node", HERE / "verify-build.mjs", target, build], stdout=subprocess.PIPE, text=True)
    manifest = json.loads(result.stdout)
    if manifest.get("patches") != [] or manifest.get("verification", {}).get("linkSmoke") != "passed":
        raise ValueError("Expected the verified, unpatched mobile llama runtime")
    for name in LICENSES:
        if name not in manifest["files"]:
            raise ValueError(f"Native build is missing its verified license: {name}")
    return manifest


def archive(output, files):
    """Stable ZIP metadata; no host timestamps, absolute paths, or symlinks."""
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as result:
        for name, source in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            result.writestr(info, source.read_bytes() if isinstance(source, Path) else source.encode())


def stage_ios(build, output, manifest):
    minimum = manifest.get("settings", {}).get("minimumOS", "")
    if not isinstance(minimum, str) or not re.fullmatch(r"\d+\.\d+", minimum):
        raise ValueError("Missing iOS deployment floor")
    package = output / "swift/GezelLlama"
    package.mkdir(parents=True)
    for relative in manifest["files"]:
        if relative.startswith("GezelLlama.xcframework/") or relative in LICENSES:
            # The package exports only Gezel's versioned ABI, not upstream's
            # changing llama/ggml C structures. Binary archive bytes are unchanged.
            if '/Headers/' in relative and Path(relative).name not in ('gezel_llama.h', 'module.modulemap'):
                continue
            destination = package / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            if destination.name == 'module.modulemap':
                destination.write_text(MODULE_MAP)
            else:
                shutil.copyfile(build / relative, destination)
    shutil.copyfile(HERE.parents[1] / "LICENSE", package / "LICENSE-gezel.txt")
    if not (package / "GezelLlama.xcframework/Info.plist").is_file():
        raise ValueError("Missing XCFramework metadata")
    (package / "Package.swift").write_text(f'''// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "GezelLlama",
    platforms: [.iOS("{minimum}")],
    products: [.library(name: "GezelLlama", targets: ["GezelLlama"])],
    targets: [.binaryTarget(name: "GezelLlama", path: "GezelLlama.xcframework")]
)
''')
    return {"swiftProduct": "GezelLlama", "package": "swift/GezelLlama"}


def android_settings(manifest, ndk):
    settings = manifest.get("settings", {})
    abis, minimum = settings.get("abis"), settings.get("minimumAPI")
    if (not isinstance(abis, list) or not abis or len(set(abis)) != len(abis)
            or any(abi not in ("arm64-v8a", "x86_64") for abi in abis)
            or type(minimum) is not int or minimum < 28):
        raise ValueError("Unsupported Android ABI or API metadata")
    revision = re.search(r"Pkg.Revision\s*=\s*(\d+\.\d+\.\d+)", (ndk / "source.properties").read_text())
    if not revision or revision[1] != manifest.get("toolchains", {}).get("ndk") or int(revision[1].split('.')[0]) < 28:
        raise ValueError("Use the exact NDK r28+ revision recorded in the runtime manifest")
    return abis, minimum


def stage_android(build, output, manifest, version, ndk, javac, work):
    abis, minimum = android_settings(manifest, ndk)
    classes = work / "classes"
    classes.mkdir()
    source = HERE / "android/java" / f"{JAVA_CLASS}.java"
    run([javac, "--release", "8", "-d", classes, source])
    jar = work / "classes.jar"
    archive(jar, {str(file.relative_to(classes)): file for file in classes.rglob("*.class")})
    files = {
        "classes.jar": jar,
        "R.txt": "",
        "proguard.txt": HERE / "android/consumer-rules.pro",
        "META-INF/LICENSE-gezel.txt": HERE.parents[1] / "LICENSE",
        "META-INF/NOTICE-android-ndk.txt": ndk / "NOTICE",
        "META-INF/NOTICE-android-toolchain.txt": ndk / "NOTICE.toolchain",
        "AndroidManifest.xml": f'<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="{GROUP}.llama"><uses-sdk android:minSdkVersion="{minimum}" /></manifest>\n',
    }
    # Reuse the build driver's ELF checks for the newly compiled binding.
    spec = importlib.util.spec_from_file_location("gezel_build", HERE / "build-llama.py")
    driver = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(driver)
    host = "darwin-x86_64" if platform.system() == "Darwin" else "linux-x86_64"
    readelf = ndk / "toolchains/llvm/prebuilt" / host / "bin/llvm-readelf"
    required = {f"lib{name}.so" for name in ("gezel-llama", "llama", "ggml", "ggml-base", "ggml-cpu", "c++_shared")}
    for abi in abis:
        libraries = {Path(name).name: build / name for name in manifest["files"] if name.startswith(f"jniLibs/{abi}/")}
        if set(libraries) != required:
            raise ValueError(f"Unexpected or missing native dependency in {abi}")
        binary = work / abi
        run(["cmake", "-S", HERE / "android", "-B", binary, "-G", "Unix Makefiles",
             f"-DCMAKE_TOOLCHAIN_FILE={ndk}/build/cmake/android.toolchain.cmake",
             f"-DANDROID_ABI={abi}", f"-DANDROID_PLATFORM=android-{minimum}", "-DANDROID_STL=c++_shared",
             "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON", "-DCMAKE_BUILD_TYPE=Release",
             f"-DGEZEL_JNI_LIBS={build / 'jniLibs'}", f"-DGEZEL_LLAMA_INCLUDE={build / 'include'}"])
        run(["cmake", "--build", binary, "--parallel", "2"])
        libraries["libgezel_llama_jni.so"] = binary / "libgezel_llama_jni.so"
        for name, file in libraries.items():
            driver.verify_elf_alignment(run([readelf, "-lW", file], capture_output=True, text=True).stdout)
            driver.verify_elf_dependencies(run([readelf, "-dW", file], capture_output=True, text=True).stdout, libraries)
            files[f"jni/{abi}/{name}"] = file
    for name in LICENSES:
        files[f"META-INF/{name}"] = build / name
    files["META-INF/gezel-runtime-manifest.json"] = build / "manifest.json"
    destination = output / "maven" / GROUP.replace('.', '/') / ARTIFACT / version
    destination.mkdir(parents=True)
    aar = destination / f"{ARTIFACT}-{version}.aar"
    archive(aar, files)
    pom = destination / f"{ARTIFACT}-{version}.pom"
    pom.write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>{GROUP}</groupId><artifactId>{ARTIFACT}</artifactId><version>{version}</version>
  <packaging>aar</packaging><name>Gezel llama runtime (local preview)</name>
  <description>Prebuilt text runtime and JNI binding; no speech or platform AI dependencies.</description>
  <licenses><license><name>MIT</name><url>https://opensource.org/license/mit</url></license></licenses>
</project>
''')
    for artifact in (aar, pom):
        artifact.with_suffix(artifact.suffix + ".sha256").write_text(digest(artifact) + "\n")
    return {"mavenCoordinates": f"{GROUP}:{ARTIFACT}:{version}", "repository": "maven",
            "bindingToolchains": {"javac": run([javac, "-version"], capture_output=True, text=True).stdout.strip(),
                                  "cmake": run(["cmake", "--version"], capture_output=True, text=True).stdout.splitlines()[0]},
            "bindingSources": {str(file.relative_to(HERE)): digest(file) for file in sorted((HERE / "android").rglob('*')) if file.is_file()}}


def stage(target, build, output, version, *, ndk=None, javac="javac"):
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", version):
        raise ValueError("Use a semantic version, preferably a unique local preview version")
    if output.exists():
        raise ValueError("Choose a new output directory; staged versions are immutable")
    if target == "android" and ndk is None:
        raise ValueError("Android staging requires --ndk (the runtime's recorded revision)")
    manifest = verify_build(build, target)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".gezel-sdk-", dir=output.parent) as directory:
        work = Path(directory)
        staged = work / "staged"
        staged.mkdir()
        metadata = (stage_ios(build, staged, manifest) if target == "ios" else
                    stage_android(build, staged, manifest, version, ndk, javac, work))
        shutil.copyfile(build / "manifest.json", staged / "runtime-manifest.json")
        metadata.update({"schemaVersion": 1, "packageVersion": version, "target": target,
                         "gezelABIVersion": manifest["gezelABIVersion"],
                         "scope": "low-level-text-runtime", "deviceInference": "not-run",
                         "files": {str(file.relative_to(staged)): digest(file) for file in sorted(staged.rglob('*')) if file.is_file()}})
        (staged / "sdk-manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
        staged.rename(output)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=("ios", "android"))
    parser.add_argument("--build", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--version", required=True)
    parser.add_argument("--ndk", type=Path, default=os.environ.get("ANDROID_NDK_HOME"))
    parser.add_argument("--javac", default="javac")
    args = parser.parse_args()
    stage(args.target, args.build.resolve(), args.output.resolve(), args.version,
          ndk=args.ndk.resolve() if args.ndk else None, javac=args.javac)
    print(f"Staged {args.target} SDK preview at {args.output}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
