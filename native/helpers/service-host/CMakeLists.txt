cmake_minimum_required(VERSION 3.20)

project(gezel_service_host LANGUAGES CXX)

# Stamped into the Windows VERSIONINFO resource. build.ps1 derives this from
# the `native-vX.Y.Z` tag being built; a bare local build leaves it 0.0.0,
# which is honest rather than a version that was never released.
set(GEZEL_SERVICE_HOST_VERSION "0.0.0" CACHE STRING "Version stamped into the Windows VERSIONINFO resource")
if(NOT GEZEL_SERVICE_HOST_VERSION MATCHES "^([0-9]+)\\.([0-9]+)\\.([0-9]+)$")
  message(FATAL_ERROR "GEZEL_SERVICE_HOST_VERSION must be X.Y.Z, got '${GEZEL_SERVICE_HOST_VERSION}'")
endif()
set(GEZEL_SERVICE_HOST_VERSION_MAJOR "${CMAKE_MATCH_1}")
set(GEZEL_SERVICE_HOST_VERSION_MINOR "${CMAKE_MATCH_2}")
set(GEZEL_SERVICE_HOST_VERSION_PATCH "${CMAKE_MATCH_3}")

set(gezel_service_host_sources src/main.cpp)
if(WIN32)
  # Only MSVC/llvm-rc consume .rc; the non-Windows build of this target exists
  # purely so `--self-test` runs cross-platform during development.
  enable_language(RC)
  configure_file(src/version.rc.in "${CMAKE_CURRENT_BINARY_DIR}/version.rc" @ONLY)
  list(APPEND gezel_service_host_sources "${CMAKE_CURRENT_BINARY_DIR}/version.rc")
endif()

add_executable(gezel-service-host ${gezel_service_host_sources})
target_compile_features(gezel-service-host PRIVATE cxx_std_17)

if(MSVC)
  target_compile_options(gezel-service-host PRIVATE /W4 /permissive- /EHsc)
  set_property(
    TARGET gezel-service-host
    PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  )
else()
  target_compile_options(gezel-service-host PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(WIN32)
  target_link_libraries(gezel-service-host PRIVATE advapi32)
endif()

include(CTest)
if(BUILD_TESTING)
  add_test(NAME service-host-self-test COMMAND gezel-service-host --self-test)
endif()
