# build.ps1 - Windows build of llama-server from the pinned
# llama.cpp upstream.
#
# Emits: native/build/win32-x64[-<backend>]/gezel-llama-server.exe
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
#   - CUDA backend: CUDA Toolkit 12.x on PATH (nvcc.exe).
#   - Vulkan backend: Vulkan SDK installed, VULKAN_SDK env var set.

param()
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $here '..\..\..') | Select-Object -ExpandProperty Path

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
$platform = 'win32-x64'

# -- 2. Resolve accelerator ----------------------------------------
$backend = if ($env:LLAMA_BACKEND) { $env:LLAMA_BACKEND } else { 'auto' }
$llamaCudaArch = if ($env:LLAMA_CUDA_ARCH) { $env:LLAMA_CUDA_ARCH } else { '' }
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
  '-DLLAMA_BUILD_SERVER=ON',
  '-DLLAMA_BUILD_TESTS=OFF',
  '-DLLAMA_BUILD_EXAMPLES=OFF',
  '-DLLAMA_CURL=OFF',
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
    $cmakeFlags += '-DGGML_CUDA=ON'
    if ($llamaCudaArch -and $llamaCudaArch -ne 'spark') {
      $cmakeFlags += "-DCMAKE_CUDA_ARCHITECTURES=$llamaCudaArch"
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
if ($backend -eq 'cuda' -and $env:CUDA_PATH) {
  $toolsetArgs = @('-T', "cuda=$env:CUDA_PATH")
  Write-Host "[build] CUDA toolset -> $env:CUDA_PATH"
}
& cmake -S $src -B $buildDir @toolsetArgs @cmakeFlags
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }
& cmake --build $buildDir --config Release --target llama-server -j
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
