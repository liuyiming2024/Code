# ============================================================
# code_runner —— QuickJS 引擎桥接
# ------------------------------------------------------------
# 前置：QuickJS 源码要放到 cpp/quickjs/ 下（见 NDK.md 的第一步）。
# 直接下载官方 quickjs 包，把 quickjs.c / quickjs.h 等平铺放进该目录即可。
#
# 为什么不用现成的 AAR：
#   官方没有维护 Android 构建；第三方 AAR 版本参差，
#   而我们要用到 JS_SetInterruptHandler（超时中断），
#   这个 API 在低版本 QuickJS 里名字不同 —— 必须自己掌握源码版本。
# ============================================================

cmake_minimum_required(VERSION 3.22.1)
project("code_runner")

set(CMAKE_C_STANDARD 11)

# QuickJS 需要这些源。缺一个都会链接失败（undefined reference）。
set(QUICKJS_DIR ${CMAKE_CURRENT_SOURCE_DIR}/quickjs)
set(QUICKJS_SRC
    ${QUICKJS_DIR}/quickjs.c
    ${QUICKJS_DIR}/libregexp.c
    ${QUICKJS_DIR}/libunicode.c
    ${QUICKJS_DIR}/libbf.c
    ${QUICKJS_DIR}/cutils.c
)

# 目录不存在时给出**明确的**错误，而不是让 CMake 报一堆
# "Cannot find source file" —— 那种报错看不出是忘了下载 QuickJS。
if(NOT EXISTS ${QUICKJS_DIR}/quickjs.c)
    message(FATAL_ERROR
        "缺少 QuickJS 源码：${QUICKJS_DIR}/quickjs.c\n"
        "请先按 native/android/NDK.md 的第一步把 QuickJS 源码放到 cpp/quickjs/ 下。")
endif()

add_library(code_runner SHARED
    quickjs_bridge.c
    ${QUICKJS_SRC}
)

target_include_directories(code_runner PRIVATE ${QUICKJS_DIR})

# QuickJS 用得到这些：setjmp（异常）、数学库、以及 dl（可选）
target_link_libraries(code_runner
    android
    log
    m
)

# QuickJS 在 Android 上需要这个宏以获得 clock_gettime 等
target_compile_definitions(code_runner PRIVATE
    CONFIG_VERSION="quickjs-android"
    _GNU_SOURCE
)
