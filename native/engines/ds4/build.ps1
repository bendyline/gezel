# build.ps1 — Windows build of ds4-server.
#
# ds4 is NOT supported on Windows. Upstream antirez/ds4 is a `make`/`uname`
# based C project with Metal/CUDA/HIP backends and no MSVC/MinGW path — a
# `ds4-server.exe` simply does not exist, and the only Windows hardware that
# could host a 284B DeepSeek-V4 MoE is a high-end NVIDIA workstation (a narrow
# population). This script is intentionally a no-op so the cross-platform
# bundle step doesn't fail looking for it.
#
# Windows users with capable NVIDIA hardware can run the linux-x64 CUDA build
# inside WSL2 and point Gezel at it via Settings -> On-device -> ds4 External
# URL. Revisit a native Windows port only if upstream ships one.

Write-Host "[build] ds4-server is not supported on Windows; skipping (use WSL2 + the linux-x64 CUDA build). No artifact produced."
exit 0
