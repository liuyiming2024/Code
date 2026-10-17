# 让原生 APP 能跑代码（NDK 接入）

界面部分（Compose）不依赖 NDK，**不配也能正常编译运行**，只是不能执行代码。
要打开"运行"能力，按下面三步来。

## 第一步：放 QuickJS 源码

```bash
mkdir -p app/src/main/cpp/quickjs
cd app/src/main/cpp/quickjs
curl -LO https://bellard.org/quickjs/quickjs-2024-01-13.tar.xz
tar xf quickjs-2024-01-13.tar.xz --strip-components=1
```

需要的文件：`quickjs.c` `quickjs.h` `libregexp.c` `libunicode.c` `libbf.c` `cutils.c`。
缺任何一个都会链接失败。`CMakeLists.txt` 会在缺失时直接报"缺少 QuickJS 源码"，
不会让你对着一堆 `undefined reference` 猜。

## 第二步：确认 build.gradle 有 externalNativeBuild

`app/build.gradle` 里 `android { }` 块内应有：

```groovy
externalNativeBuild {
    cmake { path "src/main/cpp/CMakeLists.txt" }
}
```

## 第三步：构建

Android Studio → Build → Make Project。

## 引擎缺失时会怎样

**不会闪退。** `QuickJsRunner` 在 `init` 里捕获装载失败并记住状态，
点运行时给出一句"运行时还没接上，请装 NDK 后重新构建"。
编辑器、文件树、语法高亮、撤销这些全部照常可用。

这一点是刻意设计的：`System.loadLibrary` 失败抛的是 `UnsatisfiedLinkError`，
发生在类加载时，一旦冒出去就是"打开 APP 就崩"，
而从崩溃栈里很难看出原因是"忘了配 NDK"。

## 关于是不是"套壳"

不是。界面 100% Jetpack Compose，**没有 WebView、没有联网权限**。

用 QuickJS 跑 `cpplite.js` / `pylite.js` 属于**引擎选择**，跟界面是不是网页无关
—— 就像用了 SQLite 不等于套壳。这两个解释器是本项目自研的，

## 已知边界

跑的是 **C++ / Python 子集**，不是完整编译器：模板元编程、异常、
部分冷门 STL 不支持。首次运行时界面会明确提示这一点。

需要完整 C++（真 Clang）请用网页版：https://liuyiming2024.github.io/Code/
