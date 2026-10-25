# build.ps1 - Windows build of whisper-server from the pinned
# whisper.cpp upstream.
#
# Emits: native/build/win32-{x64,arm64}/gezel-whisper-server.exe (CPU),
#        native/build/win32-arm64-cuda/gezel-whisper-server.exe (WHISPER_BACKEND=cuda)
#
# CPU on every platform. Windows on ARM also builds CUDA for RTX Spark
# (NVIDIA N1X), into the win32-arm64-cuda key beside llama-server and
# sd-server. That build links whisper and ggml statically: llama-server's
# ggml*.dll already sit in that folder under the same names, from a
# different ggml, and a shared build would overwrite them.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads scripts as
# the system codepage (cp1252) by default. Em-dashes and other
# multi-byte UTF-8 chars in comments/strings parse as garbage and
# break the file. Keep this file ASCII so it works under both 5.1
# and pwsh 7 without a BOM dance.
#
# Prereqs:
#   - Visual Studio Build Tools with "Desktop development with C++".
#   - CMake 3.24+.
#   - CUDA backend: CUDA_PATH pointing at a CUDA 13.4 Windows ARM64 toolkit
#     (native\scripts\install-cuda-arm64.ps1 assembles one), and the
#     VC.Tools.ARM64 component, since nvcc's host compiler is cl.exe.

param()
$ErrorActionPreference = 'Stop'

# Import the Visual Studio ARM64 environment for the CUDA build: the CUDA
# toolchain needs VCToolsInstallDir and cl.exe as nvcc's host compiler. Same
# helper as sd-cpp/build.ps1; the CPU build needs only clang and Ninja.
function Import-VsDevEnv {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) {
    throw "vswhere not found at $vswhere. Install Visual Studio Build Tools with the 'Desktop development with C++' workload."
  }
  $hostIsArm64 = $env:PROCESSOR_ARCHITECTURE -match '^(ARM64|aarch64)$'
  $vcComponent = 'Microsoft.VisualStudio.Component.VC.Tools.ARM64'
  $vcvarsScript = if ($hostIsArm64) { 'vcvarsarm64.bat' } else { 'vcvarsamd64_arm64.bat' }
  $vsPath = & $vswhere -latest -products * -requires $vcComponent -property installationPath
  if (-not $vsPath) {
    throw "No Visual Studio install with the $vcComponent toolset found. Install the matching C++ workload."
  }
  $vcvars = Join-Path $vsPath "VC\Auxiliary\Build\$vcvarsScript"
  if (-not (Test-Path $vcvars)) {
    throw "$vcvarsScript not found at $vcvars - the VS install looks incomplete."
  }
  Write-Host "[build] importing VS arm64 dev environment from $vsPath ($vcvarsScript)"
  $envText = & $env:ComSpec /d /c "`"$vcvars`" >nul 2>&1 && set"
  if ($LASTEXITCODE -ne 0) { throw "$vcvarsScript failed (exit $LASTEXITCODE)" }
  $devPath = $null
  foreach ($line in $envText) {
    if ($line -match '^([^=]+)=(.*)$') {
      $name = $matches[1]
      $value = $matches[2]
      if ($name -ieq 'Path') {
        if (-not $devPath -or $value -match '\\VC\\Tools\\(?:MSVC|Llvm)\\') {
          $devPath = $value
        }
        continue
      }
      [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
  }
  if (-not $devPath) { throw "$vcvarsScript did not produce a PATH value" }
  [System.Environment]::SetEnvironmentVariable('Path', $devPath, 'Process')
  if (-not $env:VSCMD_ARG_TGT_ARCH -or $env:VSCMD_ARG_TGT_ARCH -ine 'arm64') {
    throw "$vcvarsScript selected target '$env:VSCMD_ARG_TGT_ARCH'; expected 'arm64'"
  }
  if (-not (Get-Command cl -ErrorAction SilentlyContinue)) {
    throw "cl.exe is still not on PATH after importing the VS dev environment."
  }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $here '..\..\..') | Select-Object -ExpandProperty Path

# -- 1. Ensure upstream is cloned + pinned -------------------------
$fetchScript = Join-Path $repoRoot 'native\scripts\fetch-upstream.sh'
$bash = Get-Command bash -ErrorAction SilentlyContinue
if ($null -ne $bash) {
  Write-Host "[build] running fetch-upstream.sh via bash"
  & $bash.Source -c "`"$($fetchScript -replace '\\','/')`" whisper-cpp"
  if ($LASTEXITCODE -ne 0) { throw "fetch-upstream.sh failed" }
} else {
  Write-Host "[build] bash not on PATH - falling back to inline clone"
  $versionFile = Join-Path $here 'VERSION'
  $contents = Get-Content $versionFile
  $upstream = ($contents | Where-Object { $_ -match '^upstream=' }) -replace '^upstream=',''
  $commit   = ($contents | Where-Object { $_ -match '^commit=' })   -replace '^commit=',''
  if ($commit -notmatch '^[0-9a-f]{40}$') {
    throw "VERSION's commit sha is not a 40-char hex string: $commit"
  }
  if ($commit -match '^0+$') {
    throw "VERSION's commit sha is the all-zeros placeholder. Update VERSION before building."
  }
  $target = Join-Path $here '.upstream'
  if (-not (Test-Path (Join-Path $target '.git'))) {
    git clone --filter=tree:0 $upstream $target
  }
  git -C $target fetch --tags origin $commit
  git -C $target checkout --detach $commit
  git -C $target submodule update --init --recursive --depth 1
}

$src = Join-Path $here '.upstream'

# -- Resolve target architecture -----------------------------------
# Windows ships on x64 and arm64 (Snapdragon X / WoA). GEZEL_TARGET_ARCH
# overrides the host's own architecture for cross-builds and for testing
# this branch from an x64 machine.
$targetArch = if ($env:GEZEL_TARGET_ARCH) {
  $env:GEZEL_TARGET_ARCH
} else {
  $env:PROCESSOR_ARCHITECTURE
}
switch -Regex ($targetArch) {
  '^(ARM64|aarch64)$'    { $platform = 'win32-arm64'; break }
  '^(AMD64|x64|x86_64)$' { $platform = 'win32-x64';   break }
  default { throw "unsupported Windows architecture: $targetArch (set GEZEL_TARGET_ARCH to x64 or arm64)" }
}
$isArm64 = $platform -eq 'win32-arm64'

# -- Resolve backend -------------------------------------------------
$backend = if ($env:WHISPER_BACKEND) { $env:WHISPER_BACKEND } else { 'cpu' }
if ($backend -notin @('cpu', 'cuda')) { throw "unknown WHISPER_BACKEND=$backend (valid: cpu, cuda)" }
if ($backend -eq 'cuda' -and -not $isArm64) {
  throw 'WHISPER_BACKEND=cuda is built for win32-arm64 (RTX Spark) only'
}
$arm64Cuda = $backend -eq 'cuda'

# -- Preflight: required build tools -------------------------------
# Without these, cmake invocations would otherwise fail mid-pipeline
# in ways the rest of the script can't recover cleanly from. Surface
# a clear actionable error here instead.
if (-not (Get-Command cmake -ErrorAction SilentlyContinue)) {
  throw @"
cmake is not on PATH. Install it before running this script:
  winget install Kitware.CMake
...then restart your shell so PATH picks it up. See native/engines/whisper-cpp/README.md.
"@
}

# -- 2. Configure + build ------------------------------------------
$cmakeFlags = @(
  '-DCMAKE_BUILD_TYPE=Release',
  # Drops the unbundled VCOMP140.DLL import ggml's default OPENMP=ON
  # bakes into ggml-base.dll + ggml-cpu.dll. See the longer note in
  # native/engines/llama-cpp/build.sh.
  '-DGGML_OPENMP=OFF',
  # Portable CPU code. build.sh has always passed this; build.ps1 did not,
  # so the Windows binaries were tuned to whatever ISA the runner reported -
  # the native-v0.1.29 SIGILL shape. Latent on x64, immediate on arm64,
  # where the CI runners have SVE2 and no shipping laptop does.
  '-DGGML_NATIVE=OFF',
  '-DWHISPER_BUILD_SERVER=ON',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON'
)

# arm64 goes through clang and Ninja: ggml raises
# `FATAL_ERROR "MSVC is not supported for ARM, use clang"`, and the shared
# toolchain sets CMAKE_C_COMPILER=clang, which the Visual Studio generator
# cannot honour. Ninja is single-config, so `--config Release` must not be
# passed on that branch.
$configureArgs = @()
# Before the tool check: the VS environment also puts its own clang and
# Ninja on PATH.
if ($arm64Cuda) { Import-VsDevEnv }
if ($isArm64) {
  $toolchain = Join-Path $repoRoot 'native\cmake\arm64-windows-llvm.cmake'
  if (-not (Test-Path $toolchain)) { throw "arm64 toolchain file not found at $toolchain" }
  foreach ($tool in @('clang', 'ninja')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
      throw "$tool is not on PATH; the win32-arm64 build needs the LLVM toolchain and Ninja"
    }
  }
  $armArch = if ($env:WHISPER_ARM_ARCH) { $env:WHISPER_ARM_ARCH } else { 'armv8.2-a+dotprod+fp16' }
  $configureArgs = @('-G', 'Ninja', "-DCMAKE_TOOLCHAIN_FILE=$toolchain", "-DGEZEL_ARM_ARCH=$armArch")
  $cmakeFlags += "-DGGML_CPU_ARM_ARCH=$armArch"
}
$cudaArch = if ($env:WHISPER_CUDA_ARCH) { $env:WHISPER_CUDA_ARCH } else { '' }
if ($arm64Cuda) {
  # C and C++ stay on clang and the declared baseline; the CUDA half of the
  # shared toolchain points nvcc at cl.exe and the ARM64 import libraries.
  $configureArgs += '-DGEZEL_ARM64_CUDA=ON'
  $cmakeFlags += @('-DGGML_CUDA=ON', '-DBUILD_SHARED_LIBS=OFF')
  # Release legs always pin this; see WHISPER_CUDA_ARCH in build-native.yml.
  if ($cudaArch) { $cmakeFlags += "-DCMAKE_CUDA_ARCHITECTURES=$cudaArch" }
}
Write-Host "[build] platform=$platform backend=$backend cuda_architectures=$(if ($cudaArch) { $cudaArch } else { 'unset' })"

# ggml-cuda chooses the flags it hands nvcc's host compiler from the C++
# compiler (`if (NOT MSVC)`), which in this clang build would give cl.exe GCC
# flags and withhold the /Zc:preprocessor CUDA 13's CCCL needs. nvcc's only
# host compiler on Windows is cl.exe, so key both on WIN32 too, as
# sd-cpp/build.ps1 does. whisper.cpp carries ggml in-tree rather than as a
# submodule. Each line must match exactly once, so an upstream change fails
# here rather than inside nvcc.
$ggmlCudaCmake = 'ggml/src/ggml-cuda/CMakeLists.txt'
if ($arm64Cuda) {
  & git -C $src checkout -- $ggmlCudaCmake
  if ($LASTEXITCODE -ne 0) { throw "could not reset $ggmlCudaCmake" }
  $cmakePath = Join-Path $src $ggmlCudaCmake
  $text = [System.IO.File]::ReadAllText($cmakePath)
  foreach ($rewrite in @(
      @('if (GGML_ALL_WARNINGS AND NOT MSVC)', 'if (GGML_ALL_WARNINGS AND NOT MSVC AND NOT WIN32)'),
      @('if (NOT MSVC)', 'if (NOT MSVC AND NOT WIN32)'))) {
    $count = ([regex]::Matches($text, [regex]::Escape($rewrite[0]))).Count
    if ($count -ne 1) {
      throw "expected '$($rewrite[0])' once in $ggmlCudaCmake, found $count - recheck the WIN32 host-flag rewrite against the new pin"
    }
    $text = $text.Replace($rewrite[0], $rewrite[1])
  }
  [System.IO.File]::WriteAllText($cmakePath, $text, [System.Text.UTF8Encoding]::new($false))
  Write-Host "[build] ggml-cuda host flags keyed on WIN32 (cl.exe) for the clang arm64 build"
}

# The server's first call is ggml_backend_load_all(), which loads every
# ggml-<backend>.dll in the executable's folder. This build has its backends
# compiled in, and its folder is the -cuda key, where llama-server's
# ggml-cuda.dll and ggml-cpu.dll sit: loading them put a second ggml in the
# process, which aborted at startup with GGML_ASSERT(prev !=
# ggml_uncaught_exception) on every RTX Spark (native-v0.1.53). The CPU builds
# link ggml dynamically and keep the call.
$serverCpp = 'examples/server/server.cpp'
if ($arm64Cuda) {
  & git -C $src checkout -- $serverCpp
  if ($LASTEXITCODE -ne 0) { throw "could not reset $serverCpp" }
  $serverPath = Join-Path $src $serverCpp
  $text = [System.IO.File]::ReadAllText($serverPath)
  $needle = 'ggml_backend_load_all();'
  $count = ([regex]::Matches($text, [regex]::Escape($needle))).Count
  if ($count -ne 1) {
    throw "expected '$needle' once in $serverCpp, found $count - recheck the static-build backend discovery patch against the new pin"
  }
  $text = $text.Replace($needle, '/* gezel: static build, backends compiled in */')
  [System.IO.File]::WriteAllText($serverPath, $text, [System.Text.UTF8Encoding]::new($false))
  Write-Host "[build] removed backend DLL discovery from the static CUDA whisper-server"
}

$buildDir = Join-Path $src $(if ($arm64Cuda) { "build-$platform-cuda" } else { "build-$platform" })
try {
  & cmake -S $src -B $buildDir @configureArgs @cmakeFlags
  if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }
  $buildArgs = if ($isArm64) {
    @('--build', $buildDir, '--target', 'whisper-server', '-j')
  } else {
    @('--build', $buildDir, '--config', 'Release', '--target', 'whisper-server', '-j')
  }
  & cmake @buildArgs
  if ($LASTEXITCODE -ne 0) { throw "cmake build failed" }
} finally {
  if ($arm64Cuda) {
    foreach ($patched in @($ggmlCudaCmake, $serverCpp)) {
      & git -C $src checkout -- $patched
      if ($LASTEXITCODE -ne 0) { Write-Warning "could not restore $patched" }
    }
  }
}

# -- 3. Locate + copy the produced binary --------------------------
$found = Get-ChildItem -Path $buildDir -Recurse -Filter 'whisper-server.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $found) {
  throw "whisper-server.exe not produced under $buildDir - check CMake output; upstream may have renamed the target."
}
Write-Host "[build] produced: $($found.FullName)"

# The CUDA build joins llama-server and sd-server in the -cuda key, whose
# llama leg stages the NVIDIA runtime DLLs it imports.
$outKey = if ($arm64Cuda) { "$platform-cuda" } else { $platform }
$outDir = Join-Path $repoRoot "native\build\$outKey"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
# Ship under a gezel- prefix (gezel-whisper-server.exe) for process attribution
# while preserving the whisper.cpp lineage. Only the installed file is prefixed;
# the cmake --target / filter above keep the upstream name.
$serverName = 'gezel-whisper-server.exe'
Copy-Item $found.FullName (Join-Path $outDir $serverName) -Force

$buildOutDir = $found.DirectoryName
if ($arm64Cuda) {
  # Statically linked, so nothing may ride along: a whisper.dll or ggml*.dll
  # here would land on llama-server's same-named DLLs in the -cuda key.
  $shared = Get-ChildItem -Path $buildOutDir -Filter '*.dll' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^(ggml|whisper)' }
  if ($shared) {
    throw "the CUDA whisper-server must link ggml statically, but the build produced $($shared.Name -join ', ')"
  }
} else {
  # Copy ggml/whisper runtime DLLs sitting beside the exe (same pattern
  # as llama-cpp's build).
  Get-ChildItem -Path $buildOutDir -Filter '*.dll' -ErrorAction SilentlyContinue |
    ForEach-Object {
      Copy-Item $_.FullName (Join-Path $outDir $_.Name) -Force
      Write-Host "[build] bundled $($_.Name)"
    }
}

$hash = (Get-FileHash -Algorithm SHA256 (Join-Path $outDir $serverName)).Hash
Write-Host "[build] installed: $(Join-Path $outDir $serverName)"
Write-Host "[build] sha256: $hash"
