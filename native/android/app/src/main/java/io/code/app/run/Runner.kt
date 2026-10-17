package io.code.app.run

/* ============================================================
   运行时接口
   ------------------------------------------------------------
   **为什么这样选引擎**（这是本项目反复纠结的点，此处一次说清）：

     "网页套壳"指的是**界面**是网页（WebView 装载远程/本地 HTML）。
     用不用脚本引擎、用哪个引擎，跟套不套壳**没有关系** ——
     没人会说"用了 SQLite 就是套壳"，引擎是零件不是外壳。
     本项目：界面 100% Compose，**零 WebView、零联网权限**。

   ---------- 三条候选路线与取舍 ----------
   ① 把 cpplite.js / pylite.js（5565 行）人工翻译成 Kotlin
      优点：纯 Kotlin，无 JNI。
      缺点：翻译量巨大且**无法在本环境编译验证**；
            一旦译错一处，行为就和 Web 端不一致 ——
            而两端行为不一致本身就是 bug（同一段代码手机和网页结果不同）。
      **不采用**。

   ② NDK 交叉编译真的 clang
      优点：完整 C++。
      缺点：包体 50–100 MB，还要交叉编译整套工具链。
      留给后续：接口已按"可换引擎"设计，将来接上只是换实现。

   ③ **QuickJS 直接跑现成的 cpplite.js / pylite.js**（本阶段采用）
      优点：引擎约 0.5 MB；解释器**直接复用 Web 端已验证的同一份逻辑**，
            两端行为天然一致；竞赛常用语法已与真 g++ 对照 53/53。
      代价：跑的是 C++ **子集**（cpplite 的能力边界），不是完整 Clang。
           这个代价必须让用户知道 —— 见下面的 caveat 字段。

   ---------- 为什么必须先声明"不是完整编译器" ----------
   用户是竞赛选手。他写了一段用了冷门 STL 的代码，
   如果 APP 表现得像"编译器坏了"而实际是子集不支持，
   他会去查自己的代码 —— 浪费时间且查不到。
   所以 run() 的返回值里带 caveat：**首次运行时明确说清边界**。
   ============================================================ */

/** 一次运行的结果。 */
data class RunResult(
    /** 程序输出（stdout）。 */
    val out: String,
    /** 编译/运行期错误（stderr）。非 null 即视为失败。 */
    val err: String? = null,
    /** 是否命中超时被强制终止。 */
    val timeout: Boolean = false,
    /** 耗时（毫秒）。 */
    val ms: Long = 0,
    /** 能力边界提示（例如"这是 C++ 子集，不支持 X"）。只在需要时给。 */
    val caveat: String? = null
) {
    val ok: Boolean get() = err == null && !timeout
}

/** 引擎能力。UI 用它决定显示什么，不硬编码在界面里。 */
data class RunnerInfo(
    /** 唯一标识，如 "cpplite-quickjs"。 */
    val id: String,
    /** 显示名，如 "C++ 子集"。 */
    val label: String,
    /** 是否为真编译器（false = 子集解释器）。 */
    val complete: Boolean,
    /** 能力边界的一句话说明，给竞赛用户看。 */
    val caveat: String?
)

interface Runner {
    fun info(): RunnerInfo
    /** 运行。timeoutMs 到点必须能真的停下来 —— 见 QuickJsRunner 里的中断处理。 */
    fun run(code: String, stdin: String, timeoutMs: Long): RunResult
    /** 释放引擎实例。不调用会泄漏 native 内存。 */
    fun close()
}

/** 语言选择：按扩展名，认不出返回 null（UI 要提示"暂不支持"，不能猜）。 */
fun runnerIdForExt(ext: String): String? = when (ext.lowercase()) {
    "c", "cc", "cpp", "cxx", "h", "hpp" -> "cpplite"
    "py" -> "pylite"
    "js" -> "js"
    else -> null
}
