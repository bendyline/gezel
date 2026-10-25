# install-cuda-arm64.ps1 - assemble CUDA 13.4.1 for Windows on ARM from
# NVIDIA's per-component redistributable archives.
#
# NVIDIA publishes no Windows ARM64 CUDA installer; the toolkit for RTX Spark
# (NVIDIA N1X) builds comes as separate windows-arm64 redist zips. This merges
# the ones gezel's CUDA builds need (nvcc, the CRT headers, NVVM, CCCL, cudart,
# cuBLAS, cuobjdump) into one CUDA_PATH-shaped tree. Every archive is pinned by
# sha256 and checked before it is unpacked.
#
# One copy for CI (build-native.yml) and for a local build on an RTX Spark, so
# the two cannot drift onto different toolkits.
#
# Usage:
#   pwsh -File native\scripts\install-cuda-arm64.ps1 -Root <dir> [-Downloads <dir>]
#   $env:CUDA_PATH = <dir>   # then run an engine's build.ps1 with its cuda backend
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads scripts as the system
# codepage, and multi-byte characters break the parse.

param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$Downloads = ''
)
$ErrorActionPreference = 'Stop'

$base = 'https://developer.download.nvidia.com/compute/cuda/redist'
$archives = [ordered]@{
  'cuda_nvcc/windows-arm64/cuda_nvcc-windows-arm64-13.4.59-archive.zip'           = '4d26510f9d5b644e784a02b13423f9c8b79f8b15613ea0bb325bad42ed3443c4'
  'cuda_crt/windows-arm64/cuda_crt-windows-arm64-13.4.59-archive.zip'             = 'a84f570d06497cf14187ddf9a2d656d752aaf66b2025c11eb93af01a8a1ce5ff'
  'libnvvm/windows-arm64/libnvvm-windows-arm64-13.4.59-archive.zip'               = '2d051ea3fffddf67458fe66004e7045015409709c57f8cdcdade88d479b62e47'
  'cccl/windows-arm64/cccl-windows-arm64-13.3.4.2.1-archive.zip'                  = 'e8a7c96268ae6c52a7b8b07d96e1f84ab8eae5619c3b989024ce712dda5c2cc2'
  'cuda_cudart/windows-arm64/cuda_cudart-windows-arm64-13.4.49-archive.zip'       = 'd48085b557db615f1095d4a6f96d4d1fcc8ba0c4fd16ad40f30f953b6ae422cf'
  'libcublas/windows-arm64/libcublas-windows-arm64-13.7.0.27-archive.zip'         = '932794dcd1e67e152ab2aeaf32ee8141ded807c6ea6d8f85692c40b02fdd09d7'
  'cuda_cuobjdump/windows-arm64/cuda_cuobjdump-windows-arm64-13.4.49-archive.zip' = '2df6140a0cde3c33a71c8b065e0adbbee21c2b3f6d5cbc2f5128ab0493654a4c'
}

if (-not $Downloads) { $Downloads = Join-Path ([System.IO.Path]::GetTempPath()) 'gezel-cuda-redist' }
New-Item -ItemType Directory -Force -Path $Root, $Downloads | Out-Null

foreach ($archive in $archives.GetEnumerator()) {
  $zip = Join-Path $Downloads (Split-Path -Leaf $archive.Key)
  $cached = (Test-Path -LiteralPath $zip) -and
    ((Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant() -eq $archive.Value)
  if (-not $cached) {
    Invoke-WebRequest -Uri "$base/$($archive.Key)" -OutFile $zip -UseBasicParsing
  }
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
  if ($actual -ne $archive.Value) {
    throw "sha256 mismatch for $($archive.Key): expected $($archive.Value), got $actual"
  }
  Expand-Archive -LiteralPath $zip -DestinationPath $Downloads -Force
  $unpacked = Join-Path $Downloads ([System.IO.Path]::GetFileNameWithoutExtension($zip))
  robocopy $unpacked $Root /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed merging $unpacked (exit $LASTEXITCODE)" }
  Write-Host "[cuda] $(Split-Path -Leaf $archive.Key) verified and merged"
}
Copy-Item -LiteralPath (Join-Path $Root 'LICENSE') -Destination (Join-Path $Root 'EULA.txt') -Force
foreach ($required in @('bin\nvcc.exe', 'bin\cuobjdump.exe', 'nvvm\bin\cicc.exe', 'lib\arm64\cudart.lib', 'lib\arm64\cublas.lib', 'bin\arm64')) {
  if (-not (Test-Path (Join-Path $Root $required))) { throw "CUDA install is missing $required" }
}
& (Join-Path $Root 'bin\nvcc.exe') --version
if ($LASTEXITCODE -ne 0) { throw "nvcc --version failed (exit $LASTEXITCODE)" }
Get-ChildItem (Join-Path $Root 'bin\arm64') -Filter '*.dll' | ForEach-Object { Write-Host "[cuda] runtime $($_.Name)" }
# robocopy's success codes (1-7) would otherwise become this script's exit code.
exit 0
