# build.ps1 - Windows build of whisper-server from the pinned
# whisper.cpp upstream.
#
# Emits: native/build/win32-x64/gezel-whisper-server.exe
#
# Single CPU build per platform for the narration MVP. CUDA / Vulkan
# variants are deferred until audio-chat work demands the latency
# improvement.
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

param()
$ErrorActionPreference = 'Stop'

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
$platform = 'win32-x64'

# Keep hosted-runner checkout paths out of __FILE__ strings and compiler
# metadata for both the server and its bundled ggml/whisper DLLs.
$pathMapFlag = "/pathmap:$src=whisper.cpp"
$env:CL = if ($env:CL) { "$pathMapFlag $env:CL" } else { $pathMapFlag }

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
  '-DWHISPER_BUILD_SERVER=ON',
  '-DWHISPER_BUILD_TESTS=OFF',
  '-DWHISPER_BUILD_EXAMPLES=ON'
)
Write-Host "[build] platform=$platform"

$buildDir = Join-Path $src "build-$platform"
& cmake -S $src -B $buildDir @cmakeFlags
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }
& cmake --build $buildDir --config Release --target whisper-server -j
if ($LASTEXITCODE -ne 0) { throw "cmake build failed" }

# -- 3. Locate + copy the produced binary --------------------------
$found = Get-ChildItem -Path $buildDir -Recurse -Filter 'whisper-server.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $found) {
  throw "whisper-server.exe not produced under $buildDir - check CMake output; upstream may have renamed the target."
}
Write-Host "[build] produced: $($found.FullName)"

$outDir = Join-Path $repoRoot "native\build\$platform"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
# Ship under a gezel- prefix (gezel-whisper-server.exe) for process attribution
# while preserving the whisper.cpp lineage. Only the installed file is prefixed;
# the cmake --target / filter above keep the upstream name.
$serverName = 'gezel-whisper-server.exe'
Copy-Item $found.FullName (Join-Path $outDir $serverName) -Force

# Copy ggml/whisper runtime DLLs sitting beside the exe (same pattern
# as llama-cpp's build).
$buildOutDir = $found.DirectoryName
Get-ChildItem -Path $buildOutDir -Filter '*.dll' -ErrorAction SilentlyContinue |
  ForEach-Object {
    Copy-Item $_.FullName (Join-Path $outDir $_.Name) -Force
    Write-Host "[build] bundled $($_.Name)"
  }

$hash = (Get-FileHash -Algorithm SHA256 (Join-Path $outDir $serverName)).Hash
Write-Host "[build] installed: $(Join-Path $outDir $serverName)"
Write-Host "[build] sha256: $hash"
