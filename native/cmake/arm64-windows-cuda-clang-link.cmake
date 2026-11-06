# CUDA rules override for the clang-linked Windows-on-ARM CUDA builds
# (CMAKE_USER_MAKE_RULES_OVERRIDE_CUDA, set by arm64-windows-llvm.cmake when
# GEZEL_ARM64_CUDA is ON). CMake loads it right after the CUDA platform file,
# in every directory that enables CUDA.
#
# WHY. Platform/Windows-NVIDIA-CUDA.cmake includes Platform/Windows-MSVC.cmake,
# which resets two directory-wide variables to link.exe spelling:
# CMAKE_LINK_LIBRARY_FLAG "" and CMAKE_LIBRARY_PATH_FLAG "-LIBPATH:". Our
# links still go through the clang++ driver, which needs "-l" and "-L"; given
# a bare `shlwapi.lib` it looks for that file in the build directory.
# sd.cpp master-1050 began calling enable_language(CUDA) in its top-level
# directory, so the reset reached sd-server's link, and native-v0.1.58 failed
# with `clang++: error: no such file or directory: 'shlwapi.lib'` (libwebp's
# WIC dependencies) and the same for the CUDA implicit `cudadevrt.lib` and
# `cudart.lib`. Before that, only ggml-cuda's directory enabled CUDA, and it
# links nothing.
#
# The guard keeps CMake's own CUDA-only compiler checks, which link with
# link.exe-style rules, on the MSVC spelling: they never load CXX.

if(CMAKE_CXX_COMPILER_LOADED AND CMAKE_CXX_COMPILER_FRONTEND_VARIANT STREQUAL "GNU")
  set(CMAKE_LIBRARY_PATH_FLAG "-L")
  set(CMAKE_LINK_LIBRARY_FLAG "-l")
endif()
