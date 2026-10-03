cmake_minimum_required(VERSION 3.28)

project(StringArt CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_program(CCACHE_PROGRAM ccache)
if(CCACHE_PROGRAM)
    set(CMAKE_C_COMPILER_LAUNCHER   ${CCACHE_PROGRAM})
    set(CMAKE_CXX_COMPILER_LAUNCHER ${CCACHE_PROGRAM})
    message(STATUS "Using ccache: ${CCACHE_PROGRAM}")
endif()

file(GLOB_RECURSE SOURCE_FILES
    "src/*.cpp"
)

include(FetchContent)

FetchContent_Declare(
    argparse
    GIT_REPOSITORY https://github.com/p-ranav/argparse.git
    GIT_SHALLOW ON
)

FetchContent_Declare(
    stb
    GIT_REPOSITORY https://github.com/nothings/stb.git
    GIT_SHALLOW ON
)

FetchContent_MakeAvailable(argparse stb)

find_package(OpenCL REQUIRED)

add_executable(${PROJECT_NAME} main.cpp ${SOURCE_FILES})
target_link_libraries(${PROJECT_NAME} PRIVATE argparse::argparse OpenCL::OpenCL)

file(MAKE_DIRECTORY ${CMAKE_BINARY_DIR}/include/stb)
file(COPY ${stb_SOURCE_DIR}/ DESTINATION ${CMAKE_BINARY_DIR}/include/stb 
     FILES_MATCHING PATTERN "*.h")

target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_SOURCE_DIR}
)

target_include_directories(${PROJECT_NAME} SYSTEM PRIVATE
    ${CMAKE_BINARY_DIR}/include
)

target_compile_options(${PROJECT_NAME} PRIVATE 
    -Wall
    -Wextra
    -Wpedantic
    -Wold-style-cast
    -Wconversion
    -march=native 
    -mtune=native
)

if(CMAKE_BUILD_TYPE STREQUAL "Release")
    message(STATUS "Configuring project ${PROJECT_NAME} for OPTIMIZATION mode (Release)")
    
    target_compile_options(${PROJECT_NAME} PRIVATE
        -O3
    )
    
    set_property(TARGET ${PROJECT_NAME} PROPERTY INTERPROCEDURAL_OPTIMIZATION ON)
    
    target_link_options(${PROJECT_NAME} PRIVATE
        -s
    )

elseif(CMAKE_BUILD_TYPE STREQUAL "Debug")
    message(STATUS "Configuring project ${PROJECT_NAME} for PROFILING/DEBUG mode (Debug)")

    target_compile_options(${PROJECT_NAME} PRIVATE
        -g
        -fno-omit-frame-pointer
    )
    
else()
    message(STATUS "Configuring project ${PROJECT_NAME} for default mode: ${CMAKE_BUILD_TYPE}")
endif()

set_target_properties(${PROJECT_NAME} PROPERTIES 
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}"
)

