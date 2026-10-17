package io.code.app.run

import java.util.concurrent.atomic.AtomicLong

/* ============================================================
   QuickJS 引擎桥接（Kotlin 侧）
   ------------------------------------------------------------
   真正的解释在 C 侧（app/src/main/cpp/quickjs_bridge.c）；
   这里只负责：装载、调用、超时、以及**引擎缺失时的降级**。

   ---------- 最关键的一条：库没编进去不能崩 ----------
   如果用户只编译了 Kotlin 部分、没配 NDK，
   System.loadLibrary 会抛 UnsatisfiedLinkError。
   它发生在**类加载时**（companion object 的 init 块），
   一旦抛出，引用这个类的界面直接崩 —— 表现为"打开 APP 就闪退"，
   而从崩溃栈里很难看出是"忘了配 NDK"。

   所以：装载失败要**记住状态**（available=false），
   run() 时返回一条**明确说明怎么修**的错误，而不是崩。
   "能用但报告不支持" 与 "闪退" 是天壤之别。

   ---------- 为什么超时必须在引擎内部中断 ----------
   死循环 `while(1){}` 在 QuickJS 里是同步跑的。
   如果只在 Kotlin 侧用协程超时，协程被取消但**引擎线程还在跑**，
   CPU 一直 100%，且那个线程永远回不来 —— 每跑一次泄漏一个线程。
   正确做法：QuickJS 的中断回调（JS_SetInterruptHandler）里检查 deadline，
   到点让引擎自己抛出，线程正常退出。这条在 C 侧实现。
   ============================================================ */

class QuickJsRunner private constructor(
    private val handle: Long,
    /* 必须由 create() 传入。写成默认值的话，建 pylite 引擎时会显示成
       C++ 的边界说明 —— 用户看到的是"不支持模板元编程"，
       而他在写 Python。这种串台比报错更难发现。 */
    private val script: String
) : Runner {

    override fun info(): RunnerInfo = when (script) {
        "pylite" -> RunnerInfo(
            id = "pylite-quickjs",
            label = "Python 子集",
            complete = false,
            caveat = "这是自研子集解释器：支持竞赛常用语法与 math/string/random/json，" +
                "不支持 import 第三方包。需要完整 CPython 请用网页版。"
        )
        else -> RunnerInfo(
            id = "cpplite-quickjs",
            label = "C++ 子集",
            complete = false,
            caveat = "这是自研子集解释器，不是完整编译器：支持竞赛常用语法与 STL，" +
                "但不支持模板元编程、异常、部分冷门 STL。需要完整 C++ 请用网页版的真 Clang。"
        )
    }

    override fun run(code: String, stdin: String, timeoutMs: Long): RunResult {
        if (!available) {
            return RunResult(
                out = "",
                err = "运行时还没接上：QuickJS 原生库没编进 APK。\n" +
                    "请在 Android Studio 里装 NDK 后重新构建（见 native/android/NDK.md）。\n" +
                    "编辑器、文件、高亮这些不依赖它，都能正常用。",
                ms = 0
            )
        }
        val t0 = System.currentTimeMillis()
        /* 一次性把 stdout / stderr / 超时标志都取回来 ——
           分三次 JNI 调用的话，引擎状态可能已经变了（尤其超时后）。 */
        val r = nativeRun(handle, code, stdin, timeoutMs)
        return RunResult(
            out = r[0] ?: "",
            err = if ((r[1] ?: "").isEmpty()) null else r[1],
            timeout = r[2] == "1",
            ms = System.currentTimeMillis() - t0,
            caveat = if (r[2] == "1") null else info().caveat
        )
    }

    override fun close() {
        if (handle != 0L) {
            try { nativeFree(handle); noteFreed() } catch (e: Throwable) { /* 已释放就忽略 */ }
        }
    }

    /** nativeRun 返回 [out, err, timeoutFlag]。 */
    private external fun nativeRun(h: Long, code: String, stdin: String, timeoutMs: Long): Array<String?>
    private external fun nativeFree(h: Long)
    /* script 决定装哪个解释器："cpplite" 或 "pylite"。
       必须显式传 —— 让 C 侧去猜语言，猜错了会加载错误的解释器，
       表现为"写 C++ 却按 Python 报错"，极难定位。 */
    private external fun nativeNew(script: String, source: String): Long

    companion object {
        @Volatile
        private var available: Boolean = false

        @Volatile
        private var loadError: String? = null

        /** 已装载的引擎数 —— 用来在测试里确认没泄漏。 */
        private val liveCount = AtomicLong(0)

        fun isAvailable() = available
        fun loadError() = loadError
        fun liveCount() = liveCount.get()

        init {
            try {
                System.loadLibrary("code_runner")
                available = true
            } catch (e: Throwable) {
                /* 见上面"最关键的一条"：记下来，不要让它冒出去。 */
                available = false
                loadError = e.message ?: e.toString()
            }
        }

        /** 建一个引擎实例。失败返回 null（而不是抛）。
            script 只允许 "cpplite" / "pylite" —— 别的直接拒绝，
            否则会去加载一个不存在的脚本文件，报出来的是"文件读不到"，
            而不是"语言名写错了"。 */
        fun create(script: String, source: String): QuickJsRunner? {
            if (!available) return null
            if (script != "cpplite" && script != "pylite") {
                loadError = "未知解释器：$script（只支持 cpplite / pylite）"
                return null
            }
            /* 源码为空是最容易漏的一种失败：
               引擎建得出来、run 也不报错，只是永远说"Code.cpplite 不存在"。
               这种"什么都没发生"比崩溃更难查，所以在这里直接拦掉。 */
            if (source.isBlank()) {
                loadError = "解释器源码是空的（assets 里没读到 $script.js）"
                return null
            }
            return try {
                val h = QuickJsRunner(0L, script).nativeNew(script, source)
                if (h == 0L) null else {
                    liveCount.incrementAndGet()
                    QuickJsRunner(h, script)
                }
            } catch (e: Throwable) {
                loadError = e.message
                null
            }
        }

        /** close 时由调用方调；这里只维护计数，便于泄漏检测。 */
        internal fun noteFreed() { liveCount.decrementAndGet() }
    }
}
