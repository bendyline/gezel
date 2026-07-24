cmake_minimum_required(VERSION 3.20)

project(gezel_service_host LANGUAGES CXX)

add_executable(gezel-service-host src/main.cpp)
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
