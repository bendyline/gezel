# CUDA for Windows-on-ARM: the win32-arm64-cuda payload for RTX Spark
# (NVIDIA N1X, the GB10 silicon of DGX Spark), which CUDA 13.4 first supports.
#
# Used two ways, so llama-cpp and sd-cpp cannot drift apart on it:
#
#   - as the whole toolchain for llama.cpp's ggml-cuda module, which
#     llama-cpp/build.ps1 builds with MSVC in a second configure and drops
#     beside the clang-built llama-server (GGML_BACKEND_DL loads it);
#   - included by arm64-windows-llvm.cmake when GEZEL_ARM64_CUDA is ON, for
#     sd.cpp, whose CUDA code links into one clang-built executable because
#     it never calls ggml_backend_load_all().
#
# WHY THE CUDA SIDE IS ALWAYS MSVC. nvcc's only supported host compiler on
# Windows is cl.exe, so CUDA translation units go through cl even where C and
# C++ go through clang. Both target the MSVC ABI, so the objects link together.
#
# WHY THE LIBRARIES ARE SPELLED OUT. NVIDIA's ARM64 redistributables put their
# import libraries in lib/arm64, and FindCUDAToolkit picks lib/x64 from the
# host architecture. An x64 import library cannot satisfy an ARM64 link.
#
# Host: CI builds natively on windows-11-arm with NVIDIA's windows-arm64 nvcc.
# An x64 host also works, with the x64 nvcc cross-compiling via -target-dir,
# which is upstream llama.cpp's own release recipe.

set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR arm64)

if(DEFINED CUDAToolkit_ROOT)
  file(TO_CMAKE_PATH "${CUDAToolkit_ROOT}" GEZEL_CUDA_ROOT)
elseif(DEFINED ENV{CUDA_PATH})
  file(TO_CMAKE_PATH "$ENV{CUDA_PATH}" GEZEL_CUDA_ROOT)
else()
  message(FATAL_ERROR "Set CUDA_PATH to a CUDA 13.4+ toolkit with Windows ARM64 target libraries")
endif()
if(NOT EXISTS "${GEZEL_CUDA_ROOT}/lib/arm64/cudart.lib")
  message(FATAL_ERROR "${GEZEL_CUDA_ROOT} has no lib/arm64/cudart.lib; install the windows-arm64 cuda_cudart and libcublas archives")
endif()

if(NOT DEFINED ENV{VCToolsInstallDir})
  message(FATAL_ERROR "VCToolsInstallDir is not set; import the Visual Studio ARM64 environment (vcvarsarm64.bat, or vcvarsamd64_arm64.bat on x64) first")
endif()
file(TO_CMAKE_PATH "$ENV{VCToolsInstallDir}" GEZEL_MSVC_TOOLS)
if(CMAKE_HOST_SYSTEM_PROCESSOR MATCHES "^(ARM64|arm64|aarch64)$")
  set(GEZEL_MSVC_HOST_DIR Hostarm64)
else()
  set(GEZEL_MSVC_HOST_DIR Hostx64)
  set(CMAKE_CUDA_FLAGS_INIT "-target-dir=arm64")
endif()
set(GEZEL_CUDA_HOST_COMPILER "${GEZEL_MSVC_TOOLS}/bin/${GEZEL_MSVC_HOST_DIR}/arm64/cl.exe")
if(NOT EXISTS "${GEZEL_CUDA_HOST_COMPILER}")
  message(FATAL_ERROR "no ARM64-targeting cl.exe at ${GEZEL_CUDA_HOST_COMPILER}; install the VC.Tools.ARM64 component")
endif()

set(CMAKE_CUDA_COMPILER "${GEZEL_CUDA_ROOT}/bin/nvcc.exe" CACHE FILEPATH "")
set(CMAKE_CUDA_HOST_COMPILER "${GEZEL_CUDA_HOST_COMPILER}" CACHE FILEPATH "")

set(CUDA_CUDART              "${GEZEL_CUDA_ROOT}/lib/arm64/cudart.lib"   CACHE FILEPATH "")
set(CUDA_cudart_LIBRARY      "${GEZEL_CUDA_ROOT}/lib/arm64/cudart.lib"   CACHE FILEPATH "")
set(CUDA_cudart_static_LIBRARY "${GEZEL_CUDA_ROOT}/lib/arm64/cudart_static.lib" CACHE FILEPATH "")
set(CUDA_cublas_LIBRARY      "${GEZEL_CUDA_ROOT}/lib/arm64/cublas.lib"   CACHE FILEPATH "")
set(CUDA_cublasLt_LIBRARY    "${GEZEL_CUDA_ROOT}/lib/arm64/cublasLt.lib" CACHE FILEPATH "")
set(CUDA_cuda_driver_LIBRARY "${GEZEL_CUDA_ROOT}/lib/arm64/cuda.lib"     CACHE FILEPATH "")

message(STATUS "gezel: Windows-on-ARM CUDA from ${GEZEL_CUDA_ROOT}, host compiler ${GEZEL_CUDA_HOST_COMPILER}")
