cmake_minimum_required(VERSION 3.22.1)
project(icarobd_lvgl C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

# ---------------------------------------------------------------- LVGL
#
# 直接把 LVGL 的 .c 全部编进来。LVGL 自带的 CMakeLists 是给它自己的构建/示例用的，
# 在 Android 上用它反而更绕。192 个文件首次编译约几分钟，之后有 ccache/增量缓存。
#
# 仓库里只放了 src/ 与 lvgl.h（docs/examples/demos/tests 都没进来，省 10+ MB）。
file(GLOB_RECURSE LVGL_SOURCES CONFIGURE_DEPENDS
        ${CMAKE_CURRENT_SOURCE_DIR}/lvgl/src/*.c)

add_library(icarobd_lvgl SHARED
        ${LVGL_SOURCES}
        lvgl_bridge.cpp
        neon_gauge.cpp)

target_include_directories(icarobd_lvgl PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}                 # 为了找到 lv_conf.h
        ${CMAKE_CURRENT_SOURCE_DIR}/lvgl)

# LVGL 内部用 #include "lv_conf.h" 这种相对包含，需要这个宏才会去找上面那个路径
target_compile_definitions(icarobd_lvgl PRIVATE LV_CONF_INCLUDE_SIMPLE)

# -O2 很重要：LVGL 是纯软件渲染，Debug 的 -O0 会慢一个数量级
target_compile_options(icarobd_lvgl PRIVATE -O2 -ffast-math)

find_library(log_lib log)
find_library(android_lib android)
find_library(jnigraphics_lib jnigraphics)

target_link_libraries(icarobd_lvgl
        ${log_lib}
        ${android_lib}
        ${jnigraphics_lib})
