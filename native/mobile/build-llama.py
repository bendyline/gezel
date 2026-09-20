#!/usr/bin/env python3
"""Build pinned llama.cpp libraries; never fetch, patch, or build a server."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import subprocess
import sys

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parent / "engines" / "llama-cpp"


def run(args, *, capture=False):
    args = [str(arg) for arg in args]
    print("+ " + shlex.join(args), flush=True)
    return subprocess.run(args, check=True, text=True, capture_output=capture).stdout


def read_pin(path):
    values = {}
    for line in path.read_text().splitlines():
        if line and not line.startswith("#"):
            key, value = line.split("=", 1)
            values[key] = value
    if not re.fullmatch(r"[0-9a-f]{40}", values.get("commit", "")) or set(values["commit"]) == {"0"}:
        raise ValueError("VERSION must contain a nonzero, full commit SHA")
    if not re.fullmatch(r"[1-9][0-9]*", values.get("build", "")):
        raise ValueError("VERSION must contain a positive build number")
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", values.get("tag", "")):
        raise ValueError("VERSION must contain a stable vX.Y.Z tag")
    if not values.get("upstream"):
        raise ValueError("VERSION must contain the upstream URL")
    return values


def verify_source(source, pin):
    if not (source / ".git").exists():
        raise ValueError("Missing upstream checkout. Run native/scripts/fetch-upstream.sh llama-cpp first.")
    actual = run(["git", "-C", source, "rev-parse", "HEAD"], capture=True).strip()
    if actual != pin["commit"]:
        raise ValueError(f"Upstream HEAD {actual} does not match VERSION {pin['commit']}")
    count = run(["git", "-C", source, "rev-list", "--count", "HEAD"], capture=True).strip()
    if count != pin["build"]:
        raise ValueError(f"Upstream ancestry reports build {count}, expected {pin['build']}; fetch full ancestry")
    # git archive reads the pinned commit, so local desktop patches and ignored
    # files cannot enter the mobile build. No checkout state is changed.


def common_flags(pin):
    flags = [
        "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_POSITION_INDEPENDENT_CODE=ON",
        "-DLLAMA_BUILD_IS_DEV=OFF", f"-DLLAMA_BUILD_NUMBER={pin['build']}",
        f"-DLLAMA_BUILD_COMMIT={pin['commit']}",
        # An exported tree must not discover Gezel's enclosing Git repository.
        "-DGIT_EXECUTABLE=/usr/bin/false", "-DGIT_EXE=OFF",
        "-DGGML_NATIVE=OFF", "-DGGML_OPENMP=OFF", "-DGGML_LLAMAFILE=OFF",
        "-DGGML_CPU_KLEIDIAI=OFF", "-DGGML_BACKEND_DL=OFF",
        "-DGGML_CPU_ALL_VARIANTS=OFF", "-DGGML_BLAS=OFF",
        "-DLLAMA_OPENSSL=OFF", "-DLLAMA_SUBPROCESS=OFF",
    ]
    for feature in ("COMMON", "TESTS", "TOOLS", "EXAMPLES", "SERVER", "APP", "MTMD"):
        flags.append(f"-DLLAMA_BUILD_{feature}=OFF")
    # A mobile build must not inherit the host's optional GPU libraries or ISA.
    for feature in ("CUDA", "VULKAN", "HIP", "SYCL", "OPENCL", "RPC", "AVX", "AVX2", "FMA", "F16C"):
        flags.append(f"-DGGML_{feature}=OFF")
    return flags


def prerequisites(args):
    for tool in ("git", "cmake", "tar", "make"):
        if not shutil.which(tool):
            raise ValueError(f"Required build tool is missing: {tool}")
    info = {"cmake": run(["cmake", "--version"], capture=True).splitlines()[0]}
    if args.target == "ios":
        if platform.system() != "Darwin":
            raise ValueError("iOS builds require macOS with full Xcode installed")
        info["xcode"] = run(["xcodebuild", "-version"], capture=True).strip()
        for sdk in ("iphoneos", "iphonesimulator"):
            info[sdk] = run(["xcrun", "--sdk", sdk, "--show-sdk-version"], capture=True).strip()
    elif args.target == "android":
        if not args.ndk:
            raise ValueError("Android builds require --ndk /path/to/ndk or ANDROID_NDK_HOME (NDK r28+)")
        args.ndk = Path(args.ndk).expanduser().resolve()
        properties = args.ndk / "source.properties"
        revision = re.search(r"Pkg.Revision\s*=\s*(\d+)\.[^\n]+", properties.read_text())
        if not revision or int(revision[1]) < 28:
            raise ValueError("NDK r28+ is required for a 16 KB compatible libc++_shared.so")
        if not (args.ndk / "build/cmake/android.toolchain.cmake").is_file():
            raise ValueError("Android NDK CMake toolchain is missing")
        info["ndk"] = revision[0].split("=", 1)[1].strip()
        args.ndk_tools = args.ndk / "toolchains/llvm/prebuilt" / (
            "darwin-x86_64" if platform.system() == "Darwin" else "linux-x86_64")
        if not (args.ndk_tools / "bin/llvm-readelf").is_file():
            raise ValueError("Android NDK host tools are missing; supported hosts are macOS and Linux x64")
    return info


def configure_build(source, build, flags, jobs):
    run(["cmake", "-S", HERE, "-B", build, "-G", "Unix Makefiles", f"-DGEZEL_LLAMA_SOURCE_DIR={source}", *flags])
    run(["cmake", "--build", build, "--config", "Release", "--target", "gezel-llama", "--parallel", jobs])


def copy_headers(source, destination):
    destination.mkdir(parents=True)
    shutil.copy2(source / "include/llama.h", destination)
    shutil.copy2(HERE / "gezel_llama.h", destination)
    for header in (source / "ggml/include").glob("*.h"):
        shutil.copy2(header, destination)


def build_ios(args, source, output, pin):
    headers = output / "include"
    copy_headers(source, headers)
    (headers / "module.modulemap").write_text(
        'module GezelLlama {\n  header "gezel_llama.h"\n  header "llama.h"\n  link "c++"\n'
        '  link framework "Accelerate"\n  link framework "Foundation"\n'
        '  link framework "Metal"\n  link framework "MetalKit"\n  export *\n}\n')
    libraries = []
    slices = [("iphoneos", "arm64", True), ("iphonesimulator", args.simulator_arch, False)]
    for sdk, arch, metal in slices:
        build = output / "build" / sdk
        flags = common_flags(pin) + [
            "-DBUILD_SHARED_LIBS=OFF", "-DCMAKE_SYSTEM_NAME=iOS",
            f"-DCMAKE_OSX_SYSROOT={sdk}", f"-DCMAKE_OSX_ARCHITECTURES={arch}",
            f"-DCMAKE_OSX_DEPLOYMENT_TARGET={args.ios_min}",
            f"-DGGML_METAL={'ON' if metal else 'OFF'}", "-DGGML_METAL_EMBED_LIBRARY=ON",
            "-DGGML_METAL_TARGET_OS=ios", "-DGGML_ACCELERATE=ON",
        ]
        configure_build(source, build, flags, args.jobs)
        components = [build / "libgezel-llama.a", build / "llama/src/libllama.a", build / "llama/ggml/src/libggml.a",
                      build / "llama/ggml/src/libggml-base.a", build / "llama/ggml/src/libggml-cpu.a"]
        if metal:
            components.append(build / "llama/ggml/src/ggml-metal/libggml-metal.a")
        library = output / "slices" / sdk / "libGezelLlama.a"
        library.parent.mkdir(parents=True)
        run(["xcrun", "libtool", "-static", "-o", library, *components])
        # Catch missing archive components/frameworks by linking an actual app
        # executable for each slice; cross-compilation alone cannot catch these.
        sdk_path = run(["xcrun", "--sdk", sdk, "--show-sdk-path"], capture=True).strip()
        triple = f"{arch}-apple-ios{args.ios_min}" + ("-simulator" if not metal else "")
        run(["xcrun", "--sdk", sdk, "clang++", "-std=c++17", "-target", triple,
             "-isysroot", sdk_path, "-I", headers, HERE / "link-smoke.cpp", library,
             "-framework", "Accelerate", "-framework", "Foundation", "-framework", "Metal",
             "-framework", "MetalKit", "-o", library.parent / "link-smoke"])
        libraries.extend(["-library", library, "-headers", headers])
    run(["xcodebuild", "-create-xcframework", *libraries, "-output", output / "GezelLlama.xcframework"])
    return {"minimumOS": args.ios_min, "simulatorArch": args.simulator_arch,
            "deviceBackend": "metal", "simulatorBackend": "cpu"}


def verify_elf_alignment(text):
    loads = [line.split() for line in text.splitlines() if line.strip().startswith("LOAD ")]
    if not loads or any(int(parts[-1], 16) < 16384 for parts in loads):
        raise ValueError("Android shared library does not have 16 KB aligned LOAD segments")


def verify_elf_dependencies(text, packaged):
    needed = set(re.findall(r"\(NEEDED\).*\[([^\]]+)\]", text))
    system = {"libc.so", "libm.so", "libdl.so", "liblog.so", "libandroid.so"}
    missing = needed - set(packaged) - system
    if missing:
        raise ValueError("Android shared library has unbundled dependencies: " + ", ".join(sorted(missing)))


def build_android(args, source, output, pin):
    copy_headers(source, output / "include")
    triples = {"arm64-v8a": "aarch64-linux-android", "x86_64": "x86_64-linux-android"}
    for abi in args.abi:
        build = output / "build" / abi
        flags = common_flags(pin) + [
            "-DBUILD_SHARED_LIBS=ON", "-DGGML_METAL=OFF", "-DGGML_ACCELERATE=OFF",
            f"-DCMAKE_TOOLCHAIN_FILE={args.ndk}/build/cmake/android.toolchain.cmake",
            f"-DANDROID_ABI={abi}", f"-DANDROID_PLATFORM=android-{args.android_api}",
            "-DANDROID_STL=c++_shared", "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON",
            "-DCMAKE_SHARED_LINKER_FLAGS=-Wl,-z,max-page-size=16384",
        ]
        configure_build(source, build, flags, args.jobs)
        libs = output / "jniLibs" / abi
        libs.mkdir(parents=True)
        for name in ("gezel-llama", "llama", "ggml", "ggml-base", "ggml-cpu"):
            shutil.copy2(build / "bin" / f"lib{name}.so", libs)
        shutil.copy2(args.ndk_tools / "sysroot/usr/lib" / triples[abi] / "libc++_shared.so", libs)
        for library in libs.glob("*.so"):
            result = run([args.ndk_tools / "bin/llvm-readelf", "-lW", library], capture=True)
            verify_elf_alignment(result)
            dynamic = run([args.ndk_tools / "bin/llvm-readelf", "-dW", library], capture=True)
            verify_elf_dependencies(dynamic, [path.name for path in libs.glob("*.so")])
        compiler = args.ndk_tools / "bin" / f"{triples[abi]}{args.android_api}-clang++"
        run([compiler, "-std=c++17", "-I", output / "include", HERE / "link-smoke.cpp",
             "-L", libs, "-Wl,-rpath-link," + str(libs), "-lgezel-llama", "-lllama", "-lggml", "-lggml-base",
             "-lggml-cpu", "-o", build / "link-smoke"])
    return {"minimumAPI": args.android_api, "abis": args.abi, "backend": "cpu", "elfPageAlignment": 16384}


def build_host(args, source, output, pin):
    build = output / "build"
    configure_build(source, build, common_flags(pin) + [
        "-DBUILD_SHARED_LIBS=OFF", "-DGGML_METAL=OFF", "-DGGML_ACCELERATE=OFF", "-DGEZEL_MOBILE_TESTS=ON",
    ], args.jobs)
    run(["cmake", "--build", build, "--target", "gezel-llama-tests", "--parallel", args.jobs])
    run(["ctest", "--test-dir", build, "--output-on-failure"])
    return {"backend": "cpu", "contractTests": "passed", "model": "generated tiny deterministic GGUF fixture"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("target", choices=("ios", "android", "host"))
    parser.add_argument("--source", type=Path, default=ENGINE / ".upstream")
    parser.add_argument("--output", type=Path, help="Empty output directory; defaults to .build/<target>")
    parser.add_argument("--jobs", type=int, default=2)
    parser.add_argument("--check", action="store_true", help="Verify source pin and toolchains without building")
    parser.add_argument("--ios-min", default="16.4")
    parser.add_argument("--simulator-arch", choices=("arm64", "x86_64"), default="arm64")
    parser.add_argument("--ndk", default=os.environ.get("ANDROID_NDK_HOME") or os.environ.get("ANDROID_NDK"))
    parser.add_argument("--android-api", type=int, default=28)
    parser.add_argument("--abi", nargs="+", choices=("arm64-v8a", "x86_64"), default=["arm64-v8a"])
    args = parser.parse_args()
    if args.jobs < 1 or args.android_api < 28 or not re.fullmatch(r"[0-9]+\.[0-9]+", args.ios_min):
        parser.error("jobs must be positive; Android API must be >=28; iOS minimum must be major.minor")
    pin = read_pin(ENGINE / "VERSION")
    verify_source(args.source, pin)
    toolchains = prerequisites(args)
    if args.check:
        print(json.dumps({"pin": pin, "toolchains": toolchains}, indent=2))
        return
    output = (args.output or HERE / ".build" / args.target).resolve()
    if output.exists() and any(output.iterdir()):
        raise ValueError(f"Output must be empty (choose a fresh --output): {output}")
    output.mkdir(parents=True, exist_ok=True)
    source = output / "source"
    source.mkdir()
    archive = output / "upstream.tar"
    run(["git", "-C", args.source, "archive", "--format=tar", "-o", archive, pin["commit"]])
    run(["tar", "-xf", archive, "-C", source])
    archive.unlink()
    settings = {"ios": build_ios, "android": build_android, "host": build_host}[args.target](args, source, output, pin)
    shutil.copy2(source / "LICENSE", output / "LICENSE-llama-cpp.txt")
    shutil.copy2(HERE.parent / "licenses/LICENSE-ggml-MIT.txt", output / "LICENSE-ggml.txt")
    payload = output / {"ios": "GezelLlama.xcframework", "android": "jniLibs", "host": "build/gezel-llama-tests"}[args.target]
    packaged = [payload] if payload.is_file() else [path for path in payload.rglob("*") if path.is_file()]
    packaged.extend(output.glob("LICENSE-*.txt"))
    if args.target == "android":
        packaged.extend((output / "include").glob("*.h"))
    checksums = {str(path.relative_to(output)): hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in sorted(packaged)}
    (output / "manifest.json").write_text(json.dumps({
        "schemaVersion": 1, "target": args.target, "upstream": pin, "patches": [], "gezelABIVersion": 1,
        "bridgeSources": {name: hashlib.sha256((HERE / name).read_bytes()).hexdigest() for name in
                          ("gezel_llama.h", "gezel_llama.cpp", "utf8_stream.h", "CMakeLists.txt")},
        "toolchains": toolchains, "settings": settings, "files": checksums,
        "verification": {"linkSmoke": "passed", "deviceInference": "not-run", "hostContractTests": "passed" if args.target == "host" else "not-run"},
    }, indent=2) + "\n")
    print(f"Mobile llama.cpp library built: {payload}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"error: {error}", file=sys.stderr)
        sys.exit(1)
