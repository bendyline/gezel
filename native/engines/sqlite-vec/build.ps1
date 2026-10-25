# build.ps1 - Windows build of the sqlite-vec loadable extension.
#
# Compiles upstream's release amalgamation with MSVC, as upstream's own
# Windows build does (`cl /LD sqlite-vec.c`). It is plain C with no ggml, so
# the clang requirement the engines have on Windows-on-ARM does not apply.
# Both source archives are pinned by sha256 in VERSION.
#
# Emits: native\build\win32-{arm64,x64}\vec0.dll
# Only win32-arm64 is in the release matrix; npm's sqlite-vec covers x64.

param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $here '..\..\..') | Select-Object -ExpandProperty Path

# -- 1. Read VERSION pin -----------------------------------------
$pin = @{}
foreach ($line in Get-Content (Join-Path $here 'VERSION')) {
  if ($line -match '^([a-z0-9_]+)=(.+)$') { $pin[$Matches[1]] = $Matches[2].Trim() }
}
foreach ($key in 'tag', 'amalgamation_url', 'amalgamation_sha256', 'sqlite_headers_url', 'sqlite_headers_sha256') {
  if (-not $pin[$key]) { throw "sqlite-vec VERSION is missing $key=" }
}

$targetArch = if ($env:GEZEL_TARGET_ARCH) { $env:GEZEL_TARGET_ARCH } else { $env:PROCESSOR_ARCHITECTURE }
switch -Regex ($targetArch) {
  '^(ARM64|aarch64)$'    { $platform = 'win32-arm64'; $cmakePlatform = 'ARM64'; break }
  '^(AMD64|x64|x86_64)$' { $platform = 'win32-x64';   $cmakePlatform = 'x64';   break }
  default { throw "unsupported Windows architecture: $targetArch (set GEZEL_TARGET_ARCH to x64 or arm64)" }
}
Write-Host "[build] sqlite-vec $($pin.tag) for $platform"

# -- 2. Fetch and verify both archives ---------------------------
$upstream = Join-Path $here '.upstream'
New-Item -ItemType Directory -Force -Path $upstream | Out-Null

function Get-PinnedArchive([string]$url, [string]$expectedSha) {
  $file = Join-Path $upstream ([System.IO.Path]::GetFileName($url))
  if (-not (Test-Path $file) -or (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower() -ne $expectedSha) {
    Write-Host "[build] downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $file -UseBasicParsing
  }
  $actual = (Get-FileHash -Algorithm SHA256 $file).Hash.ToLower()
  if ($actual -ne $expectedSha.ToLower()) {
    Remove-Item -Force $file
    throw "sha256 mismatch for ${url}: expected $expectedSha, got $actual"
  }
  Write-Host "[build] sha256 ok: $([System.IO.Path]::GetFileName($file))"
  return $file
}

$amalgamation = Get-PinnedArchive $pin.amalgamation_url $pin.amalgamation_sha256
$headersZip = Get-PinnedArchive $pin.sqlite_headers_url $pin.sqlite_headers_sha256

# -- 3. Stage sources --------------------------------------------
$srcDir = Join-Path $upstream "src-$($pin.tag)"
$headersDir = Join-Path $upstream 'sqlite-headers'
Remove-Item -Recurse -Force $srcDir, $headersDir -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $srcDir, $headersDir | Out-Null

# Windows' own bsdtar, not whichever `tar` a Git install put first on PATH.
& (Join-Path $env:SystemRoot 'System32\tar.exe') -xzf $amalgamation -C $srcDir
if ($LASTEXITCODE -ne 0) { throw "extracting $amalgamation failed (exit $LASTEXITCODE)" }

$headersTmp = Join-Path $upstream 'sqlite-headers-zip'
Remove-Item -Recurse -Force $headersTmp -ErrorAction SilentlyContinue
Expand-Archive -Path $headersZip -DestinationPath $headersTmp -Force
foreach ($header in 'sqlite3.h', 'sqlite3ext.h') {
  $found = Get-ChildItem -Path $headersTmp -Recurse -Filter $header | Select-Object -First 1
  if (-not $found) { throw "no $header inside $headersZip" }
  Copy-Item $found.FullName (Join-Path $headersDir $header) -Force
}
Remove-Item -Recurse -Force $headersTmp

# Upstream's MSVC-on-ARM fallback for __builtin_popcountl takes an
# `unsigned int` but is called on 64-bit words, so Hamming distance over bit
# vectors silently ignores the upper half of every word. Widen the parameter.
# Exactly one match or the build stops: a bump must re-check this by hand.
$source = Join-Path $srcDir 'sqlite-vec.c'
$text = [System.IO.File]::ReadAllText($source)
$needle = 'static unsigned int __builtin_popcountl(unsigned int x) {'
$count = ([regex]::Matches($text, [regex]::Escape($needle))).Count
if ($count -ne 1) {
  throw "expected one MSVC ARM popcount fallback in sqlite-vec.c, found $count; check whether upstream fixed the 64-bit truncation and drop this patch"
}
$text = $text.Replace($needle, 'static unsigned int __builtin_popcountl(unsigned long long x) {')
[System.IO.File]::WriteAllText($source, $text, (New-Object System.Text.UTF8Encoding $false))

# -- 4. Configure and build --------------------------------------
$buildDir = Join-Path $upstream "build-$platform"
$cmakeArgs = @(
  '-S', $here,
  '-B', $buildDir,
  '-A', $cmakePlatform,
  "-DSQLITE_VEC_SOURCE_DIR=$srcDir",
  "-DSQLITE_HEADERS_DIR=$headersDir"
)
if ($platform -eq 'win32-arm64') {
  # The same explicit floor as the MSVC helpers, so a future toolchain default
  # cannot tune this redistributable to the build host.
  $cmakeArgs += '-DCMAKE_C_FLAGS=/arch:armv8.0'
}
& cmake @cmakeArgs
if ($LASTEXITCODE -ne 0) { throw "cmake configure failed (exit $LASTEXITCODE)" }
& cmake --build $buildDir --config Release --parallel
if ($LASTEXITCODE -ne 0) { throw "cmake build failed (exit $LASTEXITCODE)" }

# -- 5. Copy into the canonical output tree ----------------------
$outDir = Join-Path $repoRoot "native\build\$platform"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
Copy-Item (Join-Path $buildDir 'Release\vec0.dll') (Join-Path $outDir 'vec0.dll') -Force
$hash = (Get-FileHash -Algorithm SHA256 (Join-Path $outDir 'vec0.dll')).Hash
Write-Host "[build] installed: $(Join-Path $outDir 'vec0.dll')"
Write-Host "[build] sha256: $hash"
