# build.ps1 - Windows "build" of uv from the pinned upstream.
#
# uv ships precompiled static binaries, so this script **downloads**
# rather than compiles. Verifies the archive sha256 against the pin in
# VERSION, extracts the `uv.exe` binary, and copies it into the
# canonical native-engine output tree.
#
# Emits: native\build\win32-{x64,arm64}\uv.exe

param()
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $here '..\..\..') | Select-Object -ExpandProperty Path

# -- 1. Read VERSION pin -----------------------------------------
$versionFile = Join-Path $here 'VERSION'
$contents = Get-Content $versionFile
$tag = (($contents | Where-Object { $_ -match '^tag=' }) -replace '^tag=','').Trim()

# -- 1b. Resolve target architecture -----------------------------
# uv publishes a prebuilt archive per target triple; pick the one matching
# the architecture this leg is building for, and read the digest pinned for
# exactly that archive. GEZEL_TARGET_ARCH overrides the host's own.
$targetArch = if ($env:GEZEL_TARGET_ARCH) {
  $env:GEZEL_TARGET_ARCH
} else {
  $env:PROCESSOR_ARCHITECTURE
}
switch -Regex ($targetArch) {
  '^(ARM64|aarch64)$' {
    $platform = 'win32-arm64'
    $asset    = 'uv-aarch64-pc-windows-msvc.zip'
    $shaKey   = 'sha256_win32_arm64'
    break
  }
  '^(AMD64|x64|x86_64)$' {
    $platform = 'win32-x64'
    $asset    = 'uv-x86_64-pc-windows-msvc.zip'
    $shaKey   = 'sha256_win32_x64'
    break
  }
  default { throw "unsupported Windows architecture: $targetArch (set GEZEL_TARGET_ARCH to x64 or arm64)" }
}
$expectedSha = (($contents | Where-Object { $_ -match "^$shaKey=" }) -replace "^$shaKey=",'').Trim()

if ([string]::IsNullOrEmpty($tag) -or $tag -eq 'v0.0.0-placeholder') {
  throw 'uv VERSION is still the placeholder - pin a real release tag before building'
}
if ([string]::IsNullOrEmpty($expectedSha) -or $expectedSha -match '^0+$') {
  throw "no sha256 pinned for $platform ($shaKey in VERSION)"
}

Write-Host "[build] uv $tag for $platform ($asset)"

# -- 2. Fetch the archive ---------------------------------------
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$archive = Join-Path $tmp $asset

try {
  if ($env:UV_ARCHIVE_OVERRIDE) {
    Write-Host "[build] using override archive: $($env:UV_ARCHIVE_OVERRIDE)"
    Copy-Item $env:UV_ARCHIVE_OVERRIDE $archive
  } else {
    $url = "https://github.com/astral-sh/uv/releases/download/$tag/$asset"
    Write-Host "[build] downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
    $actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLower()
    if ($actual -ne $expectedSha.ToLower()) {
      throw "sha256 mismatch for ${asset}: expected $expectedSha, got $actual"
    }
    Write-Host "[build] sha256 ok: $actual"
  }

  # -- 3. Extract ----------------------------------------------
  $extract = Join-Path $tmp 'extract'
  New-Item -ItemType Directory -Force -Path $extract | Out-Null
  Expand-Archive -Path $archive -DestinationPath $extract -Force

  $found = Get-ChildItem -Path $extract -Recurse -Filter 'uv.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $found) {
    throw "no uv.exe found inside $asset"
  }
  Write-Host "[build] extracted: $($found.FullName)"

  # -- 4. Copy into the canonical output tree ------------------
  $outDir = Join-Path $repoRoot "native\build\$platform"
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  Copy-Item $found.FullName (Join-Path $outDir 'uv.exe') -Force

  $hash = (Get-FileHash -Algorithm SHA256 (Join-Path $outDir 'uv.exe')).Hash
  Write-Host "[build] installed: $(Join-Path $outDir 'uv.exe')"
  Write-Host "[build] sha256: $hash"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
