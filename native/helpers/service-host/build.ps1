$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$helperDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $helperDir '..\..\..')
$buildDir = Join-Path $helperDir '.build\win32-x64'
$outputDir = Join-Path $repoRoot 'native\build\win32-x64'

cmake -S $helperDir -B $buildDir -A x64 -DBUILD_TESTING=ON
cmake --build $buildDir --config Release --parallel
ctest --test-dir $buildDir -C Release --output-on-failure

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
Copy-Item -Force (Join-Path $buildDir 'Release\gezel-service-host.exe') $outputDir
Write-Host "[service-host] wrote $outputDir\gezel-service-host.exe"
