# ROCm runtime licenses

The `-rocm` variants of llama-server bundle AMD's ROCm runtime (see
`native/engines/llama-cpp/build.{sh,ps1}`). `scripts/stage-native-artifact-licenses.mjs --rocm`
stages the license of every AMD library in the payload into
`THIRD_PARTY_LICENSES/AMD-ROCm/`. Most come from the ROCm SDK's own
`share/doc/<component>/`; these are the components AMD's wheels ship without a
license text, copied verbatim from upstream:

| File | Component | Bundled as | Upstream |
|---|---|---|---|
| `LICENSE-hip-clr.md` | HIP runtime (CLR) | `amdhip64_7.dll`, `libamdhip64.so.7` | ROCm/rocm-systems `projects/clr/LICENSE.md` |
| `LICENSE-rocm-kpack.txt` | rocm-kpack | `rocm_kpack.dll`, `librocm_kpack.so.0` | ROCm/rocm-systems `shared/kpack/LICENSE` |
| `LICENSE-rocroller.md` | rocRoller (Linux) | `librocroller.so.1` | ROCm/rocm-libraries `shared/rocroller/LICENSE.md` |
| `LICENSE-llvm.txt` | LLVM (Linux) | `libLLVM.so.*`, `libclang-cpp.so.*` | ROCm/llvm-project `llvm/LICENSE.TXT` (amd-staging) |
| `LICENSE-libdrm-MIT.txt` | libdrm (Linux) | `librocm_sysdeps_drm*.so.*` | mesa/drm `LICENSES/MIT.txt` |
| `LICENSE-numactl-LGPL-2.1.txt` | numactl (Linux) | `librocm_sysdeps_numa.so.1` | numactl/numactl `LICENSE.LGPL2.1` |
| `LICENSE-elfutils-*.txt` | elfutils libelf (Linux; LGPL-3.0-or-later OR GPL-2.0-or-later) | `librocm_sysdeps_elf.so.1` | elfutils `COPYING-LGPLV3`, `COPYING`, `COPYING-GPLV2` |
| `LICENSE-zlib.txt` | zlib (Linux) | `librocm_sysdeps_z.so.1` | madler/zlib `LICENSE` |
| `LICENSE-zstd-BSD-3-Clause.txt` | zstd (Linux) | `librocm_sysdeps_zstd.so.1` | facebook/zstd `LICENSE` |
| `LICENSE-xz-liblzma-0BSD.txt` | xz liblzma (Linux) | `librocm_sysdeps_liblzma.so.5` | tukaani-project/xz `COPYING.0BSD` |
| `LICENSE-bzip2.txt` | bzip2 (Linux) | `librocm_sysdeps_bz2.so` | bzip2 `LICENSE` |

Which library maps to which text is `ROCM_LICENSES` in the staging script. A
ROCm bump that adds a library fails staging until it gets an entry there, and
the Windows signing allowlist (`packages/app/scripts/third-party-binaries.cjs`)
fails the same way for a new DLL, so a new dependency is reviewed before it
ships.

## LGPL source

numactl and elfutils are LGPL, so shipping their binaries also obliges us to
offer their source from where we offer the binaries. AMD's wheels carry neither
the source nor an offer to pass along. `scripts/rocm-lgpl-sources.mjs` pins
what AMD built them from: the release archives, by sha256, and TheRock's build
scripts and patches, by commit. The linux-x64 ROCm leg of `build-native.yml`
fetches them, and the draft native release attaches them as
`gezel-third-party-sources-<version>.tar`. Staging writes where to find it into
`THIRD_PARTY_LICENSES/AMD-ROCm/README.txt`, and fails for an LGPL- or
GPL-licensed library that has no source pinned there.
