/* rt-worker.js —— 运行时 Worker（classic 类型）
   ------------------------------------------------------------------
   所有 WASM 运行时都在这里加载并执行，主线程只管显示，不干重活。

   为什么必须用 Worker：
     clang.wasm 40 MB、ruby 33 MB，在主线程编译会白屏好几秒甚至十几秒。
     Worker 里卡住，页面照样能响应。

   为什么是 classic 而不是 module：
     importScripts 能吃 UMD（sql.js / pyodide / lua / clang 都是 UMD 或
     Emscripten 输出）。module worker 不支持 importScripts，而 ESM 版资源
     我们没抓 —— 所以走 classic，只用 UMD 资源。

   ⚠ 首次运行需要联网下载运行时；之后走 Cache Storage，断网也能用。
     这一点必须在界面上说清楚，静默失败是最差体验。
*/
'use strict';

/* 与 js/rt-worker.js 的 BASE 保持一致 —— 两处必须同源，
   否则清单里的 url 和实际下载的地址不一致，缓存永远命中不了。
   为什么换成 raw 域：见 rt-worker.js 顶部的实测说明（Release 直链无 ACAO 头）。 */
var BASE = 'https://liuyiming2024.github.io/assets/rt/';