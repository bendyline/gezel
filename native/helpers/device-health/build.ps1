$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$helperDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $helperDir '..\..\..')
# Windows ships on x64 and arm64 (Snapdragon X / WoA). This helper is plain
# C++ with no ggml, so unlike the engines it builds fine with MSVC on both;
# only the generator platform and the output key change. NVML and AMD ADL are
# dlopen'd, so an arm64 machine with neither reports them unavailable in
# `diagnostics` and still exits 0 - the normal case there, not a failure.
$targetArch = if ($env:GEZEL_TARGET_ARCH) { $env:GEZEL_TARGET_ARCH } else { $env:PROCESSOR_ARCHITECTURE }
switch -Regex ($targetArch) {
  '^(ARM64|aarch64)$'    { $platform = 'win32-arm64'; $cmakePlatform = 'ARM64'; break }
  '^(AMD64|x64|x86_64)$' { $platform = 'win32-x64';   $cmakePlatform = 'x64';   break }
  default { throw "unsupported Windows architecture: $targetArch (set GEZEL_TARGET_ARCH to x64 or arm64)" }
}

$buildDir = Join-Path $helperDir ".build\$platform"
$outputDir = Join-Path $repoRoot "native\build\$platform"
$cmakeArgs = @(
  '-S', $helperDir,
  '-B', $buildDir,
  '-A', $cmakePlatform,
  '-DBUILD_TESTING=ON'
)
if ($platform -eq 'win32-arm64') {
  # MSVC otherwise defaults to armv8.0 today; spell it out so a future
  # toolchain default cannot silently tune this redistributable to the host.
  # Keep this in the multi-element CMake argv array. Assigning a one-element
  # array through an `if` expression makes PowerShell unwrap it to a scalar;
  # splatting that scalar passes each character as a separate native argument.
  $cmakeArgs += '-DCMAKE_CXX_FLAGS=/arch:armv8.0'
}

& cmake @cmakeArgs
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed (exit $LASTEXITCODE)" }
& cmake --build $buildDir --config Release --parallel
if ($LASTEXITCODE -ne 0) { throw "cmake build failed (exit $LASTEXITCODE)" }
& ctest --test-dir $buildDir -C Release --output-on-failure
if ($LASTEXITCODE -ne 0) { throw "ctest failed (exit $LASTEXITCODE)" }

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
Copy-Item -Force (Join-Path $buildDir 'Release\gezel-device-health.exe') $outputDir
Write-Host "[device-health] wrote $outputDir\gezel-device-health.exe"
