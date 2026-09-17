# Windows-on-ARM toolchain for every gezel native engine.
#
# WHY THIS EXISTS AT ALL. ggml's ARM branch opens with
# `FATAL_ERROR "MSVC is not supported for ARM, use clang"`, so llama.cpp,
# stable-diffusion.cpp and whisper.cpp all need a clang toolchain on
# win32-arm64 — MSVC is not an option for any of them. Upstream llama.cpp
# ships its own `cmake/arm64-windows-llvm.cmake`; the other two ship
# nothing. One file here keeps the three legs on identical flags instead of
# two of them drifting against a third we do not control.
#
# WHY IT DOES NOT HARDCODE -march. Upstream's file bakes in
# `-march=armv8.7-a`. That is right for Snapdragon X Elite (Oryon) and wrong
# for the 8cx-era parts, and — more importantly — it puts the ISA decision in
# a file nobody reads when they are reasoning about which laptops a release
# runs on. `GEZEL_ARM_ARCH` makes it one overridable knob, so the Phase 0
# spike can A/B baselines without editing a toolchain file, and so
# `build.ps1` can print the value it actually used.
#
# The default excludes SVE and SME on purpose. GitHub's windows-11-arm
# runners are Cobalt / Neoverse-class parts that HAVE SVE2; no shipping
# Windows-on-ARM laptop does. A build tuned to the runner passes every test
# in CI and dies with an illegal instruction on a user's machine, and the
# build host can by definition never reproduce it. That asymmetry is why
# `scripts/assert-arm64-baseline.mjs` verifies the generated compile database
# and CMake cache afterwards, rather than trying to infer reachability from a
# linked PE disassembly (which also decodes literal pools and padding).

set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR arm64)

set(GEZEL_ARM_TARGET arm64-pc-windows-msvc)

set(CMAKE_C_COMPILER clang)
set(CMAKE_CXX_COMPILER clang++)

set(CMAKE_C_COMPILER_TARGET ${GEZEL_ARM_TARGET})
set(CMAKE_CXX_COMPILER_TARGET ${GEZEL_ARM_TARGET})
set(CMAKE_ASM_COMPILER_TARGET ${GEZEL_ARM_TARGET})

# The post-build contract inspects the commands CMake actually generated.
# Keep this in the shared toolchain so every Clang-based WoA engine emits the
# same evidence, including future engines that adopt this file.
set(CMAKE_EXPORT_COMPILE_COMMANDS ON CACHE BOOL "Emit commands for the WoA baseline audit" FORCE)
set(CMAKE_TRY_COMPILE_CONFIGURATION Release)

# Overridable from the build scripts via -DGEZEL_ARM_ARCH=... . Keep this in
# step with the LLAMA_ARM_ARCH default in llama-cpp/build.ps1; they describe
# the same hardware floor.
if(NOT DEFINED GEZEL_ARM_ARCH OR GEZEL_ARM_ARCH STREQUAL "")
  set(GEZEL_ARM_ARCH "armv8.2-a+dotprod+fp16")
endif()
message(STATUS "gezel: Windows-on-ARM baseline -march=${GEZEL_ARM_ARCH}")

# `-fvectorize -ffp-model=fast -fno-finite-math-only` mirror upstream
# llama.cpp's toolchain: fast-math without the finite-math assumption, which
# the ggml kernels rely on for inf/nan handling in softmax.
set(gezel_arch_flags "-march=${GEZEL_ARM_ARCH} -fvectorize -ffp-model=fast -fno-finite-math-only")
set(gezel_warn_flags "-Wno-format -Wno-unused-variable -Wno-unused-function -Wno-gnu-zero-variadic-macro-arguments")

set(CMAKE_C_FLAGS_INIT "${gezel_arch_flags} ${gezel_warn_flags}")
set(CMAKE_CXX_FLAGS_INIT "${gezel_arch_flags} ${gezel_warn_flags}")
set(CMAKE_ASM_FLAGS_INIT "${gezel_arch_flags} ${gezel_warn_flags}")
