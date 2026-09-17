param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$helperDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $helperDir '..\..\..')
# Windows ships on x64 and arm64 (Snapdragon X / WoA). This helper is plain
# Win32 C++ with no ggml, so MSVC builds it natively on both - only the
# developer-environment script, the required VC toolset component and the
# output key differ.
$targetArch = if ($env:GEZEL_TARGET_ARCH) { $env:GEZEL_TARGET_ARCH } else { $env:PROCESSOR_ARCHITECTURE }
switch -Regex ($targetArch) {
  '^(ARM64|aarch64)$' {
    $platform     = 'win32-arm64'
    $vcvarsScript = 'vcvarsarm64.bat'
    $vcComponent  = 'Microsoft.VisualStudio.Component.VC.Tools.ARM64'
    break
  }
  '^(AMD64|x64|x86_64)$' {
    $platform     = 'win32-x64'
    $vcvarsScript = 'vcvars64.bat'
    $vcComponent  = 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
    break
  }
  default { throw "unsupported Windows architecture: $targetArch (set GEZEL_TARGET_ARCH to x64 or arm64)" }
}

$buildDir = Join-Path $helperDir ".build\$platform"
$outputDir = Join-Path $repoRoot "native\build\$platform"

function Import-VsDevEnv {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path $vswhere)) {
    throw "vswhere not found at $vswhere. Install Visual Studio Build Tools with the 'Desktop development with C++' workload."
  }

  $vsPath = & $vswhere -latest -products * -requires $vcComponent -property installationPath
  if ($LASTEXITCODE -ne 0) {
    throw "vswhere failed (exit $LASTEXITCODE)"
  }
  if (-not $vsPath) {
    throw "No Visual Studio install with the $vcComponent toolset found. Install the 'Desktop development with C++' workload."
  }

  $vcvars = Join-Path $vsPath "VC\Auxiliary\Build\$vcvarsScript"
  if (-not (Test-Path $vcvars)) {
    throw "$vcvarsScript not found at $vcvars - the Visual Studio install looks incomplete."
  }

  Write-Host "[service-host] importing VS $platform dev environment from $vsPath"
  $envText = & $env:ComSpec /d /c "`"$vcvars`" >nul 2>&1 && set"
  if ($LASTEXITCODE -ne 0) {
    throw "$vcvarsScript failed (exit $LASTEXITCODE)"
  }

  # A parent process can contain both `Path` and `PATH`. cmd.exe then
  # prints both, with the vcvars-updated value normally named `PATH`.
  # Prefer the value containing the MSVC tool directory so an inherited
  # stale duplicate cannot overwrite the developer environment.
  $devPath = $null
  foreach ($line in $envText) {
    if ($line -notmatch '^([^=]+)=(.*)$') {
      continue
    }

    $name = $matches[1]
    $value = $matches[2]
    if ($name -ieq 'Path') {
      if (-not $devPath -or $value -match '\\VC\\Tools\\MSVC\\[^;]+\\bin\\') {
        $devPath = $value
      }
      continue
    }

    [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
  }

  if (-not $devPath) {
    throw "$vcvarsScript did not produce a PATH value."
  }
  [System.Environment]::SetEnvironmentVariable('Path', $devPath, 'Process')

  if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
    throw "cl.exe is not on PATH after importing the Visual Studio developer environment."
  }
  if (-not (Get-Command ninja.exe -ErrorAction SilentlyContinue)) {
    throw "ninja.exe is not on PATH after importing the Visual Studio developer environment. Install the 'C++ CMake tools for Windows' component."
  }
}

function Reset-BuildDirIfGeneratorChanged {
  param(
    [Parameter(Mandatory)]
    [string] $BuildDir,
    [Parameter(Mandatory)]
    [string] $Generator
  )

  $cache = Join-Path $BuildDir 'CMakeCache.txt'
  if (-not (Test-Path $cache)) {
    return
  }

  $match = Select-String -Path $cache -Pattern '^CMAKE_GENERATOR:INTERNAL=(.*)$' | Select-Object -First 1
  $cachedGenerator = if ($match) { $match.Matches[0].Groups[1].Value } else { '' }
  if ($cachedGenerator -eq $Generator) {
    return
  }

  $buildRoot = Resolve-Path (Join-Path $helperDir '.build')
  $resolvedBuildDir = Resolve-Path $BuildDir
  $buildRootPrefix = $buildRoot.Path.TrimEnd('\') + '\'
  if (-not $resolvedBuildDir.Path.StartsWith($buildRootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove build directory outside $buildRootPrefix`: $($resolvedBuildDir.Path)"
  }

  Write-Host "[service-host] existing build dir uses generator '$cachedGenerator', want '$Generator' - resetting $($resolvedBuildDir.Path)"
  Remove-Item -LiteralPath $resolvedBuildDir.Path -Recurse -Force
}

function Resolve-VersionStamp {
  # The Windows VERSIONINFO resource needs an X.Y.Z. The native pipeline builds
  # on a `native-vX.Y.Z` tag push, so GITHUB_REF_NAME already carries the
  # release being cut — no extra workflow wiring, and the stamp cannot drift
  # from the tag. Manual dispatch runs and local builds have no tag and stay
  # 0.0.0 rather than claiming a release they are not part of.
  if ($env:GEZEL_SERVICE_HOST_VERSION) {
    $explicit = $env:GEZEL_SERVICE_HOST_VERSION.Trim()
    if ($explicit -notmatch '^\d+\.\d+\.\d+$') {
      throw "GEZEL_SERVICE_HOST_VERSION must be X.Y.Z, got '$explicit'"
    }
    return $explicit
  }
  if ($env:GITHUB_REF_NAME -and $env:GITHUB_REF_NAME -match '^native-v(\d+\.\d+\.\d+)$') {
    return $matches[1]
  }
  return '0.0.0'
}

Import-VsDevEnv
Reset-BuildDirIfGeneratorChanged -BuildDir $buildDir -Generator 'Ninja'

$versionStamp = Resolve-VersionStamp
Write-Host "[service-host] stamping VERSIONINFO $versionStamp"
$baselineArgs = if ($platform -eq 'win32-arm64') {
  @('-DCMAKE_CXX_FLAGS=/arch:armv8.0')
} else {
  @()
}

& cmake -S $helperDir -B $buildDir -G Ninja -DCMAKE_BUILD_TYPE=Release -DBUILD_TESTING=ON -DGEZEL_SERVICE_HOST_VERSION="$versionStamp" @baselineArgs
if ($LASTEXITCODE -ne 0) {
  throw "cmake configure failed (exit $LASTEXITCODE)"
}

& cmake --build $buildDir --parallel
if ($LASTEXITCODE -ne 0) {
  throw "cmake build failed (exit $LASTEXITCODE)"
}

& ctest --test-dir $buildDir --output-on-failure
if ($LASTEXITCODE -ne 0) {
  throw "ctest failed (exit $LASTEXITCODE)"
}

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
$builtExe = Join-Path $buildDir 'gezel-service-host.exe'
if (-not (Test-Path $builtExe)) {
  throw "Build completed without producing $builtExe"
}
Copy-Item -Force $builtExe $outputDir
Write-Host "[service-host] wrote $outputDir\gezel-service-host.exe"
