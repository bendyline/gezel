$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$helperDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $helperDir '..\..\..')
$buildDir = Join-Path $helperDir '.build\win32-x64'
$outputDir = Join-Path $repoRoot 'native\build\win32-x64'
$pathMapFlag = "/pathmap:$($repoRoot.Path)=gezel"
$env:CL = if ($env:CL) { "$pathMapFlag $env:CL" } else { $pathMapFlag }

cmake -S $helperDir -B $buildDir -A x64 `
  "-DCMAKE_C_FLAGS=$pathMapFlag" "-DCMAKE_CXX_FLAGS=$pathMapFlag" `
  -DBUILD_TESTING=ON
cmake --build $buildDir --config Release --parallel
ctest --test-dir $buildDir -C Release --output-on-failure

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
Copy-Item -Force (Join-Path $buildDir 'Release\gezel-device-health.exe') $outputDir
Write-Host "[device-health] wrote $outputDir\gezel-device-health.exe"
