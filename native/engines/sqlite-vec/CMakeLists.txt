cmake_minimum_required(VERSION 3.24)

# Static CRT (CMP0091). Upstream's Windows build uses `cl /LD`, which implies
# /MT, and gezel ships no ARM64 Visual C++ redistributable: a /MD build would
# import VCRUNTIME140.dll and fail to load on a clean Windows-on-ARM machine.
cmake_policy(SET CMP0091 NEW)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")

project(gezel_sqlite_vec C)

if(NOT SQLITE_VEC_SOURCE_DIR OR NOT SQLITE_HEADERS_DIR)
  message(FATAL_ERROR "set SQLITE_VEC_SOURCE_DIR and SQLITE_HEADERS_DIR (build.ps1 does)")
endif()

add_library(vec0 SHARED "${SQLITE_VEC_SOURCE_DIR}/sqlite-vec.c")
target_include_directories(vec0 PRIVATE "${SQLITE_VEC_SOURCE_DIR}" "${SQLITE_HEADERS_DIR}")

# SQLite derives a loadable extension's entry point from the letters of its
# file name: `vec0.dll` loads `sqlite3_vec_init`. A `gezel-` prefix would make
# it look for `sqlite3_gezelsqlitevec_init` and fail, so the file keeps
# upstream's name.
set_target_properties(vec0 PROPERTIES PREFIX "" OUTPUT_NAME "vec0")
