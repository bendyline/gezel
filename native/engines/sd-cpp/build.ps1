# build.ps1 - Windows build of sd-server from the pinned
# stable-diffusion.cpp upstream.
#
# Emits: native/build/win32-x64/gezel-sd-server.exe
#
# Backend default is Vulkan - it works on virtually every modern GPU
# without requiring the CUDA toolkit. Override with $env:SD_BACKEND
# (values: vulkan, cuda, cpu).
#
# Toolchain: this script bootstraps the Visual Studio x64 developer
# environment (via vswhere + vcvars64.bat) and builds with the Ninja
# generator, which ships with VS. That is deliberate. CMake's Visual
# Studio generator auto-detects the MSVC toolset on most hosts, but
# newer VS + CMake combinations - notably "Visual Studio 18 2026" with
# CMake 4.x - fail that detection from a bare shell with "No
# CMAKE_C_COMPILER could be found" even when cl.exe is installed.
# Importing the dev environment and using Ninja is version-independent
# (VS 2019/2022/2026 alike) and faster than MSBuild.
#
# Prereqs: Visual Studio Build Tools with the "Desktop development
# with C++" workload (provides cl.exe, the Windows SDK, and - via the
# "C++ CMake tools for Windows" component - ninja.exe), CMake 3.18+,
# git. Vulkan backend also needs the Vulkan SDK installed (VULKAN_SDK
# set) so CMake can find vulkan-1.lib.

param()
$ErrorActionPreference = 'Stop'

# Import the Visual Studio x64 "Native Tools" environment into this
# session so cl.exe, ninja, and the Windows SDK land on PATH for the
# cmake calls below. Located via vswhere (ships with every VS 2017+
# install). The environment is captured from vcvars64.bat rather than
# Enter-VsDevShell because the vcvars contract is stable across VS
# versions while the DevShell module API has shifted between them.
function Import-VsDevEnv {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) {
    throw "vswhere not found at $vswhere. Install Visual Studio Build Tools with the 'Desktop development with C++' workload."
  }
  $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $vsPath) {
    throw "No Visual Studio install with the VC++ x64 toolset found. Install the 'Desktop development with C++' workload."
  }
  $vcvars = Join-Path $vsPath 'VC\Auxiliary\Build\vcvars64.bat'
  if (-not (Test-Path $vcvars)) {
    throw "vcvars64.bat not found at $vcvars - the VS install looks incomplete."
  }
  Write-Host "[build] importing VS x64 dev environment from $vsPath"
  # Redirect vcvars' own banner to nul; `&& set` then dumps the
  # resulting environment one KEY=VALUE per line, but only if vcvars
  # succeeded. Re-import each var into this process so the child
  # cmake / ninja / cl inherit it. SetEnvironmentVariable (not Set-Item
  # env:) handles names with parens like ProgramFiles(x86).
  $envText = & cmd /c "`"$vcvars`" >nul 2>&1 && set"
  if ($LASTEXITCODE -ne 0) { throw "vcvars64.bat failed (exit $LASTEXITCODE)" }
  foreach ($line in $envText) {
    if ($line -match '^([^=]+)=(.*)$') {
      [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }
  if (-not (Get-Command cl -ErrorAction SilentlyContinue)) {
    throw "cl.exe is still not on PATH after importing the VS dev environment."
  }
}

# CMake refuses to reconfigure a build dir created with a different
# generator ("does not match the generator used previously"). When an
# existing checkout switches from the old VS-generator builds to Ninja,
# wipe the stale cache so the configure starts clean.
function Reset-BuildDirIfGeneratorChanged {
  param([string]$BuildDir, [string]$Generator)
  $cache = Join-Path $BuildDir 'CMakeCache.txt'
  if (-not (Test-Path $cache)) { return }
  $match = Select-String -Path $cache -Pattern '^CMAKE_GENERATOR:INTERNAL=(.*)$' | Select-Object -First 1
  $cached = ''
  if ($match) { $cached = $match.Matches[0].Groups[1].Value }
  if ($cached -ne $Generator) {
    Write-Host "[build] existing build dir uses generator '$cached', want '$Generator' - wiping $BuildDir"
    Remove-Item -Recurse -Force $BuildDir
  }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $here '..\..\..') | Select-Object -ExpandProperty Path

# --- 1. Ensure upstream is cloned + pinned ---
# Shell out to bash if it's available (Git for Windows ships bash),
# otherwise replicate the minimum logic inline. Keeping one source of
# truth reduces drift.
$fetchScript = Join-Path $repoRoot 'native\scripts\fetch-upstream.sh'
$bash = Get-Command bash -ErrorAction SilentlyContinue
if ($null -ne $bash) {
  Write-Host "[build] running fetch-upstream.sh via bash"
  & $bash.Source -c "`"$($fetchScript -replace '\\','/')`" sd-cpp"
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

# --- 2. Resolve accelerator ---
$backend = if ($env:SD_BACKEND) { $env:SD_BACKEND } else { 'vulkan' }
$cmakeFlags = @(
  '-DCMAKE_BUILD_TYPE=Release',
  # Drops the unbundled VCOMP140.DLL import ggml's default OPENMP=ON
  # bakes into ggml-base.dll + ggml-cpu.dll and into sd-server.exe
  # itself. See the longer note in native/engines/llama-cpp/build.sh.
  '-DGGML_OPENMP=OFF',
  # stable-diffusion.cpp's generated translation unit exceeds COFF's default
  # section count on current MSVC. /bigobj raises that object-file limit.
  '-DCMAKE_CXX_FLAGS=/bigobj',
  # See build.sh: upstream auto-builds the sdcpp-webui React frontend
  # whenever pnpm is on PATH, and gezel's own pnpm-workspace.yaml
  # confuses that install. Disable so the build is deterministic and
  # matches what CI ships (which never had pnpm installed either).
  '-DSD_SERVER_BUILD_FRONTEND=OFF'
)
# NOTE: upstream removed the `SD_BUILD_SERVER` option - the server is
# now an unconditional `add_subdirectory(server)`. Don't reintroduce it.
switch ($backend) {
  'vulkan' { $cmakeFlags += '-DSD_VULKAN=ON' }
  'cuda'   { $cmakeFlags += '-DSD_CUDA=ON' }
  'cpu'    { }
  default  { throw "unknown SD_BACKEND=$backend (valid: vulkan, cuda, cpu)" }
}
Write-Host "[build] platform=$platform backend=$backend"

# --- 3. Bring up the MSVC toolchain (cl + ninja + Windows SDK) ---
Import-VsDevEnv
if (-not (Get-Command ninja -ErrorAction SilentlyContinue)) {
  throw "ninja not found after importing the VS dev environment. Install the 'C++ CMake tools for Windows' component in the VS installer."
}

# --- 4. Configure + build (Ninja) ---
$buildDir = Join-Path $src "build-$platform-$backend"
Reset-BuildDirIfGeneratorChanged $buildDir 'Ninja'
& cmake -S $src -B $buildDir -G Ninja @cmakeFlags
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed" }
& cmake --build $buildDir --target sd-server -j
if ($LASTEXITCODE -ne 0) { throw "cmake build failed" }

# --- 5. Locate + copy the produced binary ---
$found = Get-ChildItem -Path $buildDir -Recurse -Filter 'sd-server.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $found) {
  throw "sd-server.exe not produced under $buildDir - check CMake output for the target name upstream is using."
}
Write-Host "[build] produced: $($found.FullName)"

$outDir = Join-Path $repoRoot "native\build\$platform"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
# Ship under a gezel- prefix (gezel-sd-server.exe) for process attribution
# while preserving the stable-diffusion.cpp lineage. Only the installed file
# is prefixed; the cmake --target / filter above keep the upstream name.
$serverName = 'gezel-sd-server.exe'
Copy-Item $found.FullName (Join-Path $outDir $serverName) -Force
$hash = (Get-FileHash -Algorithm SHA256 (Join-Path $outDir $serverName)).Hash
Write-Host "[build] installed: $(Join-Path $outDir $serverName)"
Write-Host "[build] sha256: $hash"
