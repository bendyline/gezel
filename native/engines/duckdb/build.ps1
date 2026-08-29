# build.ps1 - Windows "build" of the DuckDB CLI from the pinned upstream.
#
# DuckDB ships a precompiled single-file CLI, so this script **downloads**
# rather than compiles. Verifies the archive sha256 against the pin in
# VERSION, extracts the `duckdb.exe` binary, and copies it into the
# canonical native-engine output tree.
#
# Emits: native\build\win32-x64\duckdb.exe

param()
$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $here '..\..\..') | Select-Object -ExpandProperty Path

# -- 1. Read VERSION pin -----------------------------------------
$versionFile = Join-Path $here 'VERSION'
$contents = Get-Content $versionFile
$tag         = ($contents | Where-Object { $_ -match '^tag=' })              -replace '^tag=',''
$commit      = ($contents | Where-Object { $_ -match '^commit=' })           -replace '^commit=',''
$expectedSha = ($contents | Where-Object { $_ -match '^sha256_win32_x64=' }) -replace '^sha256_win32_x64=',''
$tag = $tag.Trim()
$commit = $commit.Trim()
$expectedSha = $expectedSha.Trim()

if ([string]::IsNullOrEmpty($tag) -or $tag -eq 'v0.0.0-placeholder') {
  throw 'duckdb VERSION is still the placeholder - pin a real release tag before building'
}
if ([string]::IsNullOrEmpty($expectedSha) -or $expectedSha -match '^0+$') {
  throw 'no sha256 pinned for win32-x64 (sha256_win32_x64 in VERSION)'
}

$platform = 'win32-x64'
$asset = 'duckdb_cli-windows-amd64.zip'
Write-Host "[build] duckdb $tag for $platform"

# -- 2. Fetch the archive ---------------------------------------
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$archive = Join-Path $tmp $asset

try {
  if ($env:DUCKDB_ARCHIVE_OVERRIDE) {
    Write-Host "[build] using override archive: $($env:DUCKDB_ARCHIVE_OVERRIDE)"
    Copy-Item $env:DUCKDB_ARCHIVE_OVERRIDE $archive
  } else {
    $url = "https://github.com/duckdb/duckdb/releases/download/$tag/$asset"
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

  $found = Get-ChildItem -Path $extract -Recurse -Filter 'duckdb.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $found) {
    throw "no duckdb.exe found inside $asset"
  }
  Write-Host "[build] extracted: $($found.FullName)"

  # -- 4. Smoke test the pinned build --------------------------
  # `duckdb --version` echoes the upstream commit; confirming it against
  # the VERSION pin proves we extracted the build we think we did.
  $versionOut = (& $found.FullName --version 2>&1 | Out-String).Trim()
  Write-Host "[build] version: $versionOut"
  if (-not [string]::IsNullOrEmpty($commit) -and $commit -notmatch '^0+$') {
    $short = $commit.Substring(0, 10)
    if ($versionOut -notmatch [regex]::Escape($short)) {
      throw "duckdb --version does not mention pinned commit ${short}: $versionOut"
    }
  }
  $smoke = ('SELECT 1;' | & $found.FullName -noheader -list ':memory:' 2>&1 | Out-String).Trim()
  if ($smoke -ne '1') {
    throw "duckdb smoke query did not return 1: $smoke"
  }

  # -- 5. Copy into the canonical output tree ------------------
  $outDir = Join-Path $repoRoot "native\build\$platform"
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  Copy-Item $found.FullName (Join-Path $outDir 'duckdb.exe') -Force

  $hash = (Get-FileHash -Algorithm SHA256 (Join-Path $outDir 'duckdb.exe')).Hash
  Write-Host "[build] installed: $(Join-Path $outDir 'duckdb.exe')"
  Write-Host "[build] sha256: $hash"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
