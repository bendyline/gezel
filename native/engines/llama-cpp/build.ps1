# build.ps1 - Windows build of llama-server from the pinned
# llama.cpp upstream.
#
# Emits: native/build/win32-{x64,arm64}[-<backend>]/gezel-llama-server.exe
#
# Backend defaults to CUDA (nvcc on PATH) -> Vulkan (Vulkan SDK present)
# -> CPU. Override with $env:LLAMA_BACKEND (values: cuda, vulkan, cpu).
#
# Gezel's release matrix builds three variants on Windows (cuda, vulkan,
# cpu) and picks the right one at runtime. For local iteration, pick
# one; CI sets $env:LLAMA_BACKEND_TAG=1 to emit to the variant-suffixed
# directory so multi-variant builds don't clobber each other.
#
# Prereqs:
#   - Visual Studio Build Tools with "Desktop development with C++".
#   - CMake 3.24+.
#   - CUDA backend: CUDA Toolkit 12.x on PATH (nvcc.exe). win32-arm64 needs
#     CUDA 13.4+ with the ARM64 libraries (CUDA_PATH\lib\arm64, bin\arm64)
#     and the VC.Tools.ARM64 component; see native/cmake/arm64-windows-cuda.cmake.
#   - Vulkan backend: Vulkan SDK installed, VULKAN_SDK env var set.

param()
$ErrorActionPreference = 'Stop'

# Import the Visual Studio target environment into this session, the same way
# sd-cpp/build.ps1 does. Only the win32-arm64 CUDA backend needs it: nvcc's one
# supported host compiler on Windows is cl.exe, while every other leg here
# either uses the Visual Studio generator or clang (which finds MSVC itself).
function Import-VsDevEnv {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) {
    throw "vswhere not found at $vswhere. Install Visual Studio Build Tools with the 'Desktop development with C++' workload."
  }
  $hostIsArm64 = $env:PROCESSOR_ARCHITECTURE -match '^(ARM64|aarch64)$'
  if ($isArm64) {
    $vcComponent = 'Microsoft.VisualStudio.Component.VC.Tools.ARM64'
    $vcvarsScript = if ($hostIsArm64) { 'vcvarsarm64.bat' } else { 'vcvarsamd64_arm64.bat' }
    $expectedVsTarget = 'arm64'
  } else {
    $vcComponent = 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
    $vcvarsScript = 'vcvars64.bat'
    $expectedVsTarget = 'x64'
  }

  $vsPath = & $vswhere -latest -products * -requires $vcComponent -property installationPath
  if (-not $vsPath) {
    throw "No Visual Studio install with the $vcComponent toolset found. Install the matching C++ workload."
  }
  $vcvars = Join-Path $vsPath "VC\Auxiliary\Build\$vcvarsScript"
  if (-not (Test-Path $vcvars)) {
    throw "$vcvarsScript not found at $vcvars - the VS install looks incomplete."
  }
  Write-Host "[build] importing VS $expectedVsTarget dev environment from $vsPath ($vcvarsScript)"
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
  if (-not $env:VSCMD_ARG_TGT_ARCH -or $env:VSCMD_ARG_TGT_ARCH -ine $expectedVsTarget) {
    throw "$vcvarsScript selected target '$env:VSCMD_ARG_TGT_ARCH'; expected '$expectedVsTarget'"
  }
  if (-not (Get-Command cl -ErrorAction SilentlyContinue)) {
    throw "cl.exe is still not on PATH after importing the VS dev environment."
  }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $here '..\..\..') | Select-Object -ExpandProperty Path
$src = Join-Path $here '.upstream'
$runtimePatch = Join-Path $here 'patches\muse-runtime.patch'
# Recover only our exact patch after an interrupted build, preserving other edits.
if (Test-Path (Join-Path $src '.git')) {
  $patchApplied = & {
    # Windows PowerShell turns native stderr into a terminating error under
    # Stop, even when redirected. A clean checkout is an expected probe miss.
    $ErrorActionPreference = 'Continue'
    & git -C $src apply --reverse --check $runtimePatch 2>$null
    $LASTEXITCODE -eq 0
  }
  if ($patchApplied) {
    & git -C $src apply --reverse $runtimePatch
    if ($LASTEXITCODE -ne 0) { throw 'Could not recover Muse runtime patch' }
  }
}

# -- 1. Ensure upstream is cloned + pinned -------------------------
$fetchScript = Join-Path $repoRoot 'native\scripts\fetch-upstream.sh'
$bash = Get-Command bash -ErrorAction SilentlyContinue
if ($null -ne $bash) {
  Write-Host "[build] running fetch-upstream.sh via bash"
  & $bash.Source -c "`"$($fetchScript -replace '\\','/')`" llama-cpp"
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
  $target = Join-Path $here '.upstream'
  if (-not (Test-Path (Join-Path $target '.git'))) {
    git clone --filter=tree:0 $upstream $target
  }
  git -C $target fetch --tags origin $commit
  git -C $target checkout --detach $commit
  git -C $target submodule update --init --recursive --depth 1
}

$src = Join-Path $here '.upstream'
& git -C $src apply --check $runtimePatch
if ($LASTEXITCODE -ne 0) { throw 'Muse runtime patch does not match the upstream pin' }
& git -C $src apply $runtimePatch
if ($LASTEXITCODE -ne 0) { throw 'Could not apply Muse runtime patch' }
try {

# -- 1b. Resolve target architecture -------------------------------
# Windows ships on x64 and arm64 (Snapdragon X / WoA). The two legs differ
# in more than a directory name: ggml raises
# `FATAL_ERROR "MSVC is not supported for ARM, use clang"`, so the arm64
# build has to go through upstream's own clang toolchain file, and its CPU
# backend cannot use runtime ISA dispatch (see section 2b).
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

# -- 2. Resolve accelerator ----------------------------------------
$backend = if ($env:LLAMA_BACKEND) { $env:LLAMA_BACKEND } else { 'auto' }
$llamaCudaArch = if ($env:LLAMA_CUDA_ARCH) { $env:LLAMA_CUDA_ARCH } else { '' }
if ($isArm64) {
  # Windows-on-ARM ships CPU for every device, plus CUDA for RTX Spark
  # (NVIDIA N1X): CUDA 13.4 is the first toolkit with Windows ARM64 support,
  # and it is built as a split (section 4b), not in one configure. `auto`
  # stays CPU, so CUDA is only ever built when asked for. There is no Vulkan
  # leg here, and Adreno would be OpenCL - a separate variant. Refuse rather
  # than silently downgrade, so a mistaken LLAMA_BACKEND in CI is loud.
  if ($backend -eq 'auto') { $backend = 'cpu' }
  if ($backend -notin @('cpu', 'cuda')) {
    throw "LLAMA_BACKEND=$backend is not available on win32-arm64 (cpu or cuda)"
  }
}
# On arm64 the configure below is the CPU build either way; for CUDA, section
# 4b adds ggml-cuda.dll from a second, MSVC configure.
$splitCuda = $isArm64 -and $backend -eq 'cuda'
if ($backend -eq 'auto') {
  if (Get-Command nvcc -ErrorAction SilentlyContinue) {
    $backend = 'cuda'
  } elseif ($env:VULKAN_SDK) {
    $backend = 'vulkan'
  } else {
    $backend = 'cpu'
  }
}

$cmakeFlags = @(
  '-DCMAKE_BUILD_TYPE=Release',
  # ggml defaults GGML_OPENMP=ON, which makes ggml-base.dll and
  # ggml-cpu.dll import VCOMP140.DLL - part of the MSVC redistributable,
  # which we do not ship. ggml's native threadpool covers the OFF path.
  # See the longer note in native/engines/llama-cpp/build.sh.
  '-DGGML_OPENMP=OFF',
  # Portable CPU code. ggml defaults GGML_NATIVE=ON, and on MSVC that
  # runs FindSIMD.cmake against the BUILD HOST, baking /arch:AVX512 (or
  # whatever the runner supports) into ggml-cpu.dll. The shipped binary
  # then SIGILLs - reported as an illegal-instruction crash before the
  # engine ever binds its port - on any user CPU that lacks the runner's
  # instruction set, and CI cannot catch it because the machine that
  # built the binary can by definition execute it. See the much longer
  # note in build.sh; this is the same defect on the same runner pool.
  # How the portable CPU code is then selected differs per arch - see
  # section 2b.
  '-DGGML_NATIVE=OFF',
  '-DGGML_BACKEND_DL=ON'
)

# -- 2b. CPU ISA policy --------------------------------------------
# x64 gets upstream's release recipe: one dlopen-able ggml-cpu-<variant>.dll
# per ISA level, picked at load time from what the running CPU reports.
#
# arm64 cannot. ggml's ARM variant table (ggml/src/CMakeLists.txt) covers
# Linux, Android and Apple only and raises
# `FATAL_ERROR "Unsupported ARM target OS: Windows"` otherwise, and
# GGML_CPU_ARM_ARCH and GGML_CPU_ALL_VARIANTS are mutually exclusive besides.
# So this leg pins ONE baseline for every shipping Windows-on-ARM part.
#
# The default deliberately excludes SVE and SME. Snapdragon X Elite (Oryon)
# has neither, and the windows-11-arm CI runners - Cobalt / Neoverse-class -
# have both, so a host-tuned build is green in CI and SIGILLs on the target
# laptop. `armv8.2-a+dotprod+fp16` also still runs on the 8cx-era parts,
# which lack the i8mm that Oryon has. Raising this to `armv8.7-a` (Oryon's
# actual level, i8mm included) is a measurable win that the Phase 0 spike
# should A/B on real hardware - override with LLAMA_ARM_ARCH - but it drops
# the older devices, so it is not the default until someone has measured it.
#
# Whatever lands here, scripts/assert-arm64-baseline.mjs verifies every
# generated compiler command plus the CMake cache after the build.
if ($isArm64) {
  $armArch = if ($env:LLAMA_ARM_ARCH) { $env:LLAMA_ARM_ARCH } else { 'armv8.2-a+dotprod+fp16' }
  $cmakeFlags += "-DGGML_CPU_ARM_ARCH=$armArch"
  Write-Host "[build] arm64 CPU baseline: $armArch (SVE/SME excluded by design)"
} else {
  $cmakeFlags += '-DGGML_CPU_ALL_VARIANTS=ON'
}

$cmakeFlags += @(
  # Upstream defaults LLAMA_BUILD_IS_DEV=ON, which stamps the binary
  # `<version>-dev`; its CMakeLists says to set it OFF "when making a release
  # from a release tag (vX.Y.Z)", which is always what gezel pins. Mirrors
  # build.sh.
  '-DLLAMA_BUILD_IS_DEV=OFF',
  '-DLLAMA_BUILD_SERVER=ON',
  '-DLLAMA_BUILD_TESTS=OFF',
  '-DLLAMA_BUILD_EXAMPLES=OFF',
  '-DLLAMA_CURL=OFF',
  # No embedded web UI: the prebuilt bundle is an unpinned build-time download
  # of ~160 npm packages for a page gezel never serves (`--no-webui`). Mirrors
  # build.sh.
  '-DLLAMA_BUILD_UI=OFF',
  '-DLLAMA_USE_PREBUILT_UI=OFF',
  # No OpenSSL. This gates cpp-httplib's CPPHTTPLIB_OPENSSL_SUPPORT -
  # llama-server terminating TLS itself - which gezel never uses: the
  # engine is spawned on loopback and spoken to over plain HTTP.
  #
  # The old `-DLLAMA_SERVER_SSL=OFF` note here was about b8892, which
  # ignored that flag and linked OpenSSL unconditionally; the workaround
  # was to copy libssl/libcrypto out of the build host's Git for Windows
  # MinGW tree. b10099 has a real option, so we turn it off and ship no
  # OpenSSL at all rather than redistributing an unpinned MSYS2 build.
  '-DLLAMA_OPENSSL=OFF'
)
switch ($backend) {
  'cuda'   {
    if (-not $splitCuda) {
      $cmakeFlags += '-DGGML_CUDA=ON'
      if ($llamaCudaArch -and $llamaCudaArch -ne 'spark') {
        $cmakeFlags += "-DCMAKE_CUDA_ARCHITECTURES=$llamaCudaArch"
      }
    }
  }
  'vulkan' { $cmakeFlags += '-DGGML_VULKAN=ON' }
  'cpu'    { }
  default  { throw "unknown LLAMA_BACKEND=$backend (valid: cuda, vulkan, cpu)" }
}
Write-Host "[build] platform=$platform backend=$backend cuda_architectures=$(if ($llamaCudaArch) { $llamaCudaArch } else { 'unset' })"

$buildDir = Join-Path $src "build-$platform-$backend"

# -- 3. Configure + build ------------------------------------------
# CUDA on Windows: the runner's CMake auto-detection of the CUDA Visual
# Studio toolset is broken (CMake 4.x emits "No CUDA toolset found" at
# enable_language(CUDA)) even though Jimver installs the CUDA VS integration
# and CUDA_PATH is set. Point the VS generator at the toolkit explicitly with
# -T cuda=<path>; CMake then loads the MSBuild integration from the install's
# extras\visual_studio_integration. cpu/vulkan don't enable the CUDA language,
# so they configure fine without it.
$toolsetArgs = @()
if ($backend -eq 'cuda' -and -not $isArm64 -and $env:CUDA_PATH) {
  $toolsetArgs = @('-T', "cuda=$env:CUDA_PATH")
  Write-Host "[build] CUDA toolset -> $env:CUDA_PATH"
}

# arm64 needs clang, not MSVC: ggml's ARM branch opens with
# `FATAL_ERROR "MSVC is not supported for ARM, use clang"`. Upstream ships a
# toolchain file of its own, but it hardcodes -march=armv8.7-a; gezel's
# native/cmake/arm64-windows-llvm.cmake carries the same flags with the
# baseline as one overridable knob, shared with sd-cpp and whisper-cpp so
# the three legs cannot drift. The toolchain is also Ninja-only - it sets
# CMAKE_C_COMPILER=clang, which the Visual Studio generator cannot honour -
# and Ninja is single-config, so the `--config Release` the VS generator
# needs must not be passed on this branch.
$generatorArgs = @()
if ($isArm64) {
  $toolchain = Join-Path $repoRoot 'native\cmake\arm64-windows-llvm.cmake'
  if (-not (Test-Path $toolchain)) {
    throw "arm64 toolchain file not found at $toolchain"
  }
  foreach ($tool in @('clang', 'ninja')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
      throw "$tool is not on PATH; the win32-arm64 build needs the LLVM toolchain and Ninja"
    }
  }
  $generatorArgs = @('-G', 'Ninja', "-DCMAKE_TOOLCHAIN_FILE=$toolchain", "-DGEZEL_ARM_ARCH=$armArch")
}

& cmake -S $src -B $buildDir @generatorArgs @toolsetArgs @cmakeFlags
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }
$buildArgs = @('--build', $buildDir, '--target', 'llama-server', '-j')
if (-not $isArm64) { $buildArgs = @('--build', $buildDir, '--config', 'Release', '--target', 'llama-server', '-j') }
& cmake @buildArgs
if ($LASTEXITCODE -ne 0) { throw "cmake build failed" }

# -- 4. Locate + copy the produced binary --------------------------
$found = Get-ChildItem -Path $buildDir -Recurse -Filter 'llama-server.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $found) {
  throw "llama-server.exe not produced under $buildDir - check CMake output; upstream may have renamed the target."
}
Write-Host "[build] produced: $($found.FullName)"

$variantTag = if ($env:LLAMA_BACKEND_TAG -eq '1') { "$platform-$backend" } else { $platform }
$outDir = Join-Path $repoRoot "native\build\$variantTag"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
# Ship under a gezel- prefix (gezel-llama-server.exe) so the process reads as
# Gezel's in Windows Task Manager / GPU listings while keeping the upstream
# llama.cpp lineage. cmake --target and the Get-ChildItem filter above keep the
# upstream name; only the installed file is prefixed.
$serverName = 'gezel-llama-server.exe'
Copy-Item $found.FullName (Join-Path $outDir $serverName) -Force

# Runtime diagnostics sidecar, matching build.sh. Keep it beside the binary so
# crash records can identify the exact upstream pin, backend, toolkit and CUDA
# targets used to produce a release artifact.
$versionContents = Get-Content (Join-Path $here 'VERSION')
$pinnedCommit = ($versionContents | Where-Object { $_ -match '^commit=' }) -replace '^commit=',''
$metadata = [ordered]@{
  schemaVersion = 1
  engine = 'llama-cpp'
  revision = $pinnedCommit
  platform = $platform
  backend = $backend
}
if ($backend -eq 'cuda') {
  if ($llamaCudaArch) {
    $metadata.cudaArchitectures = @($llamaCudaArch -split ';')
  }
  $nvccVersionText = (& nvcc --version 2>$null) -join "`n"
  if ($nvccVersionText -match 'release\s+([^,]+)') {
    $metadata.cudaToolkit = $Matches[1]
  }
}
$metadataPath = Join-Path $outDir 'gezel-llama-build.json'
$metadataJson = ($metadata | ConvertTo-Json -Depth 4) + "`n"
[System.IO.File]::WriteAllText(
  $metadataPath,
  $metadataJson,
  [System.Text.UTF8Encoding]::new($false)
)

# Copy llama.cpp's own runtime DLLs sitting beside the exe in the
# build output: ggml.dll, ggml-base.dll, ggml-cpu.dll, ggml-cuda.dll
# (CUDA build), ggml-vulkan.dll (Vulkan build), llama.dll, and any
# other peer .dll the upstream cmake target produced. These load
# lazily - `llama-server --version` works without them, but loading a
# model dies with STATUS_DLL_NOT_FOUND (0xC0000135). Earlier versions
# of this script only copied the exe; the smoke test caught CUDA
# runtime DLLs but not these. Glob the whole peer set so we don't have
# to maintain a per-version filename list as upstream evolves.
$buildOutDir = $found.DirectoryName
Get-ChildItem -Path $buildOutDir -Filter '*.dll' -ErrorAction SilentlyContinue |
  ForEach-Object {
    Copy-Item $_.FullName (Join-Path $outDir $_.Name) -Force
    Write-Host "[build] bundled $($_.Name)"
  }

# -- 4b. win32-arm64 CUDA: ggml-cuda.dll from a second, MSVC configure --
# One configure cannot build both halves: ggml rejects MSVC for its ARM CPU
# code unless GGML_NATIVE tunes it to the build host (which section 2b
# forbids), and nvcc accepts no host compiler but cl.exe on Windows. This is
# upstream llama.cpp's own release recipe for its win-cuda-arm64 zip: the
# clang CPU build above, plus ggml-cuda.dll built here with GGML_CPU=OFF.
# GGML_BACKEND_DL loads it at runtime, and it imports ggml-base.dll by name,
# which the CPU build provides from the same pinned, patched source.
if ($splitCuda) {
  Import-VsDevEnv
  $cudaToolchain = Join-Path $repoRoot 'native\cmake\arm64-windows-cuda.cmake'
  $cudaBuildDir = Join-Path $src "build-$platform-cuda-backend"
  $cudaFlags = @(
    '-G', 'Ninja',
    "-DCMAKE_TOOLCHAIN_FILE=$cudaToolchain",
    '-DCMAKE_BUILD_TYPE=Release',
    '-DGGML_BACKEND_DL=ON',
    '-DGGML_CPU=OFF',
    '-DGGML_CUDA=ON',
    '-DGGML_NATIVE=OFF',
    '-DGGML_OPENMP=OFF',
    '-DLLAMA_BUILD_IS_DEV=OFF',
    '-DLLAMA_BUILD_SERVER=OFF',
    '-DLLAMA_BUILD_TESTS=OFF',
    '-DLLAMA_BUILD_EXAMPLES=OFF',
    '-DLLAMA_CURL=OFF',
    '-DLLAMA_BUILD_UI=OFF',
    '-DLLAMA_USE_PREBUILT_UI=OFF',
    '-DLLAMA_OPENSSL=OFF'
  )
  # Release legs always pin the architectures; see LLAMA_CUDA_ARCH in
  # build-native.yml for what an unpinned GPU-less configure ships.
  if ($llamaCudaArch) { $cudaFlags += "-DCMAKE_CUDA_ARCHITECTURES=$llamaCudaArch" }
  & cmake -S $src -B $cudaBuildDir @cudaFlags
  if ($LASTEXITCODE -ne 0) { throw "cmake configure failed (ggml-cuda)" }
  & cmake --build $cudaBuildDir --target ggml-cuda -j
  if ($LASTEXITCODE -ne 0) { throw "cmake build failed (ggml-cuda)" }
  $cudaModule = Get-ChildItem -Path $cudaBuildDir -Recurse -Filter 'ggml-cuda.dll' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $cudaModule) { throw "ggml-cuda.dll not produced under $cudaBuildDir" }
  Copy-Item $cudaModule.FullName (Join-Path $outDir 'ggml-cuda.dll') -Force
  Write-Host "[build] bundled ggml-cuda.dll (MSVC + nvcc, loaded through GGML_BACKEND_DL)"
}

# CPU-dispatch guard, mirroring build.sh section 6b2. Both arches are
# defending against the same thing - a CPU backend silently compiled for the
# build host - but they reach it from opposite directions, so the guard is
# the opposite shape on each.
#
# x64: GGML_CPU_ALL_VARIANTS is only doing its job if several
# ggml-cpu-<variant>.dll modules landed; if a pin bump drops the option or
# renames them, cmake does NOT fail - it quietly reverts to one host-tuned
# ggml-cpu.dll and the symptom is a SIGILL on somebody else's machine weeks
# later.
#
# arm64: runtime dispatch is unavailable (section 2b), so exactly ONE
# ggml-cpu.dll is correct and several would mean CPU_ALL_VARIANTS came back -
# which on this platform cannot have worked, because ggml has no Windows ARM
# variant table. The baseline that module was compiled to is what actually
# matters here, and that is proven downstream from compile_commands.json and
# CMakeCache.txt by scripts/assert-arm64-baseline.mjs.
$variantDlls = @(Get-ChildItem -Path $outDir -Filter 'ggml-cpu-*.dll' -ErrorAction SilentlyContinue)
if ($isArm64) {
  $cpuDll = Join-Path $outDir 'ggml-cpu.dll'
  if (-not (Test-Path $cpuDll)) {
    throw "expected a single ggml-cpu.dll on win32-arm64, found none - the CPU backend did not build"
  }
  if ($variantDlls.Count -gt 0) {
    throw ("found $($variantDlls.Count) ggml-cpu-<variant>.dll modules on win32-arm64 - " +
           "GGML_CPU_ALL_VARIANTS is not supported for Windows ARM and must stay off")
  }
  Write-Host "[build] cpu-dispatch guard passed (single arm64 baseline module)"
} else {
  if ($variantDlls.Count -lt 2) {
    throw ("expected multiple ggml-cpu-<variant>.dll modules, found $($variantDlls.Count) - " +
           "GGML_CPU_ALL_VARIANTS did not take effect, so the CPU backend is compiled for " +
           "THIS build host's instruction set and will SIGILL on any user CPU that lacks it")
  }
  Write-Host "[build] cpu-dispatch guard passed ($($variantDlls.Count) variant modules)"
}

# CUDA builds also depend on cuBLAS / cuDART DLLs from the CUDA Toolkit
# (NOT produced by the llama.cpp build itself). llama.cpp does not
# statically link these; they must travel with the binary. Copy the
# runtime DLLs from the CUDA bin dir into the output directory so the
# produced binary is self-contained.
if ($backend -eq 'cuda') {
  $cudaBin = $null
  if ($env:CUDA_PATH) {
    $cudaBin = Join-Path $env:CUDA_PATH 'bin'
  } else {
    $nvcc = Get-Command nvcc -ErrorAction SilentlyContinue
    if ($nvcc) { $cudaBin = Split-Path -Parent $nvcc.Source }
  }
  # NVIDIA's ARM64 redistributables keep their DLLs in bin\arm64; bin itself
  # holds the compiler, which may be an x64 build when cross-compiling.
  if ($cudaBin -and $isArm64) { $cudaBin = Join-Path $cudaBin 'arm64' }
  if ($cudaBin -and (Test-Path $cudaBin)) {
    # Names vary across CUDA versions. Wildcard-match and copy what's
    # there; CI should verify the binary loads cleanly.
    #
    # The set below covers everything `cublasLt64_*.dll` itself
    # transitively needs at process-startup time on CUDA 12.x:
    #   - cudart    : the CUDA runtime
    #   - cublas    : matrix ops
    #   - cublasLt  : "lite" matmul (cublasLt is what newer llama.cpp
    #                  actually links against for tensor-core kernels)
    #   - nvJitLink : runtime kernel JIT linker that cublasLt loads
    #                  STATICALLY at startup. Without it, the binary
    #                  exits 0xC0000135 (DLL_NOT_FOUND) BEFORE main()
    #                  runs - which is exactly the failure mode we
    #                  shipped in 0.1.5 on machines whose PATH doesn't
    #                  already include CUDA_PATH\bin (e.g. Electron).
    #   - nvrtc     : runtime compiler the JIT path uses to produce
    #                  PTX from CUDA C++. Sometimes loaded lazily, but
    #                  bundling is cheap.
    $patterns = @(
      'cudart64_*.dll',
      'cublas64_*.dll',
      'cublasLt64_*.dll',
      'nvJitLink_*.dll',
      'nvrtc64_*.dll',
      'nvrtc-builtins64_*.dll'
    )
    foreach ($p in $patterns) {
      Get-ChildItem -Path $cudaBin -Filter $p -ErrorAction SilentlyContinue |
        ForEach-Object {
          Copy-Item $_.FullName (Join-Path $outDir $_.Name) -Force
          Write-Host "[build] bundled CUDA runtime DLL: $($_.Name)"
        }
    }
  } else {
    Write-Warning "[build] could not locate CUDA bin dir - CUDA runtime DLLs NOT bundled. llama-server.exe will fail to start on machines without CUDA toolkit installed."
  }
}

# OpenSSL: not linked, not bundled. There used to be a block here that
# copied libssl-3-x64.dll / libcrypto-3-x64.dll out of the build host's
# Git for Windows MinGW tree, because b8892 linked OpenSSL unconditionally
# and the loader would exit 0xC0000135 without them. That shipped an
# unpinned MSYS2 build of a TLS library, frozen until the next native
# release. b10099 has a real `LLAMA_OPENSSL` option, set OFF above, so
# there is nothing to bundle. Don't reinstate the scavenge — if the engine
# ever needs to serve HTTPS, use upstream's vendored BoringSSL/LibreSSL.

$hash = (Get-FileHash -Algorithm SHA256 (Join-Path $outDir $serverName)).Hash
Write-Host "[build] installed: $(Join-Path $outDir $serverName)"
Write-Host "[build] sha256: $hash"
} finally {
  & git -C $src apply --reverse $runtimePatch
  if ($LASTEXITCODE -ne 0) { throw 'Could not clean up Muse runtime patch' }
}
