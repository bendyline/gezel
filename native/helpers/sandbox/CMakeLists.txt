cmake_minimum_required(VERSION 3.20)

project(gezel_sandbox LANGUAGES C)

add_executable(gezel-sandbox src/main.c)
target_compile_features(gezel-sandbox PRIVATE c_std_11)
target_compile_options(gezel-sandbox PRIVATE -Wall -Wextra -Wpedantic -O2)
# Linked against the system C library like every other engine (not
# statically: a static glibc would carry LGPL relinking terms into the
# release). It needs nothing past the release's glibc 2.38 floor.

include(CTest)
if(BUILD_TESTING)
  add_test(NAME sandbox-self-test COMMAND gezel-sandbox --self-test)
  add_test(NAME sandbox-features COMMAND gezel-sandbox --features)
  set_tests_properties(sandbox-features PROPERTIES PASS_REGULAR_EXPRESSION "^deny-net\n")
  # The forward-compatibility promise: a rule this build lacks, or no rule
  # at all, is refused rather than run unconfined.
  add_test(NAME sandbox-refuses-unknown-rules COMMAND gezel-sandbox --deny-files -- true)
  set_tests_properties(sandbox-refuses-unknown-rules PROPERTIES WILL_FAIL TRUE)
  add_test(NAME sandbox-requires-a-rule COMMAND gezel-sandbox -- true)
  set_tests_properties(sandbox-requires-a-rule PROPERTIES WILL_FAIL TRUE)
endif()
