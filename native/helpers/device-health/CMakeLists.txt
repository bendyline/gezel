cmake_minimum_required(VERSION 3.20)

project(gezel_device_health LANGUAGES CXX)

add_executable(gezel-device-health src/main.cpp)
target_compile_features(gezel-device-health PRIVATE cxx_std_17)

if(MSVC)
  target_compile_options(gezel-device-health PRIVATE /W4 /permissive- /EHsc)
  set_property(
    TARGET gezel-device-health
    PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  )
else()
  target_compile_options(gezel-device-health PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(UNIX AND NOT APPLE)
  target_link_libraries(gezel-device-health PRIVATE dl)
endif()

if(WIN32)
  target_link_libraries(gezel-device-health PRIVATE pdh)
endif()

include(CTest)
if(BUILD_TESTING)
  add_test(NAME device-health-self-test COMMAND gezel-device-health --self-test)
endif()
