cmake_minimum_required(VERSION 3.20)

project(gezel_netjail LANGUAGES C)

add_executable(gezel-netjail src/main.c)
target_compile_features(gezel-netjail PRIVATE c_std_11)
target_compile_options(gezel-netjail PRIVATE -Wall -Wextra -Wpedantic -O2)
# Linked against the system C library like every other engine (not
# statically: a static glibc would carry LGPL relinking terms into the
# release). It needs nothing past the release's glibc 2.38 floor.

include(CTest)
if(BUILD_TESTING)
  add_test(NAME netjail-self-test COMMAND gezel-netjail --self-test)
endif()
