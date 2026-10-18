package io.code.app.judge

import io.code.app.run.QuickJsRunner
import io.code.app.run.RunResult
import kotlinx.coroutines.*

/* ============================================================
   判题执行层
   ------------------------------------------------------------
   ---------- 本文件最重要的一条：每组样例必须用**新引擎** ----------
   RunHost 为了速度会**复用**引擎实例。判题**不能**复用，原因是：

     第 1 组跑了 `int x = 5;`
     第 2 组没写 `int x` 却能读到 5

   用户会以为自己的代码对了 —— 而实际是上一组的状态漏过来了。
   这种"看起来通过"比明确失败更糟：它会让人提交一段错的代码。

   网页端踩过完全一样的坑（pyodide 复用实例后不清命名空间），
   所以这里从一开始就按"每组独立"设计，不去赌引擎能清干净。

   代价：每组要重建一次引擎（载入解释器源码）。
   换来的是组间零污染。**正确性优先于速度**，因为判错的代价更高。

   ---------- 超时后必须丢弃引擎 ----------
   中断是在引擎执行中途打断的，此时解释器内部状态**不明**：
   可能半个表达式求值到一半，可能符号表改了一半。
   拿它跑下一组，结果不可信 —— 而且**不会报错**，
   表现为下一组莫名其妙地 WA 或 RE。
   所以超时/出错后一律 close()，下一组重新建。

   ---------- 为什么不用 RunHost ----------
   RunHost 只许同时跑一个、且复用引擎，两个特性都跟判题冲突。
   所以判题单独走一条路，不共用它的实例缓存。
   ============================================================ */

/** 判题的整体结果。 */
data class JudgeReport(
    val results: List<CaseResult>,
    val cancelled: Boolean = false
) {
    val allPassed: Boolean get() = !cancelled && JudgeOps.allPassed(results)
    val summary: String
        get() = if (cancelled) "已取消" else JudgeOps.summary(results)
    /** 第一组失败的，UI 直接跳到它。 */
    val firstFailure: CaseResult? get() = JudgeOps.firstFailure(results)
}

class JudgeRunner {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @Volatile
    private var currentJob: Job? = null

    /**
     * 跑全部样例。
     * onProgress 每组跑完回调一次（这样用户不用干等到最后）；
     * onDone 全部结束回调。都在主线程。
     */
    fun judge(
        code: String,
        cases: List<JudgeCase>,
        script: String,
        source: String,
        timeoutMs: Long = DEFAULT_CASE_TIMEOUT_MS,
        onProgress: (CaseResult) -> Unit = {},
        onDone: (JudgeReport) -> Unit
    ) {
        currentJob?.cancel()
        currentJob = scope.launch {
            val results = mutableListOf<CaseResult>()
            var cancelled = false
            for ((i, c) in cases.withIndex()) {
                if (!isActive) { cancelled = true; break }
                val r = runOne(code, c, i + 1, script, source, timeoutMs)
                results.add(r)
                withContext(Dispatchers.Main) { onProgress(r) }
            }
            val report = JudgeReport(results, cancelled)
            withContext(Dispatchers.Main) { onDone(report) }
        }
    }

    /** 跑一组。同步，测试可直接调。 */
    private fun runOne(
        code: String,
        c: JudgeCase,
        index: Int,
        script: String,
        source: String,
        timeoutMs: Long
    ): CaseResult {
        val t0 = System.currentTimeMillis()
        val engine = QuickJsRunner.create(script, source)
            ?: return CaseResult(
                index = index,
                verdict = Verdict.UNKNOWN,
                actual = "",
                expected = c.expected,
                ms = System.currentTimeMillis() - t0,
                error = "运行时没接上：${QuickJsRunner.loadError() ?: "QuickJS 原生库没编进 APK"}"
            )

        return try {
            val r: RunResult = engine.run(code, c.input, timeoutMs)
            val ms = System.currentTimeMillis() - t0
            when {
                r.timeout -> CaseResult(index, Verdict.TLE, r.out, c.expected, ms,
                    "超过 ${timeoutMs}ms 被终止")
                r.err != null -> CaseResult(
                    index,
                    /* 编译错误和运行错误在子集解释器里都从 err 出来，
                       靠文本区分不可靠 —— 统一按"没跑出结果"处理，
                       把原文给用户，让他自己看。
                       猜错类型比不猜更糟：用户会照着错的提示去查。 */
                    if (looksLikeCompile(r.err)) Verdict.CE else Verdict.RE,
                    r.out, c.expected, ms, r.err
                )
                JudgeOps.compare(r.out, c.expected) ->
                    CaseResult(index, Verdict.AC, r.out, c.expected, ms)
                else -> CaseResult(index, Verdict.WA, r.out, c.expected, ms)
            }
        } catch (e: Throwable) {
            CaseResult(
                index, Verdict.RE, "", c.expected,
                System.currentTimeMillis() - t0, "运行出错：${e.message ?: e}"
            )
        } finally {
            /* ⚠ 无条件释放。超时、出错、正常都要释放 ——
               漏一个就泄漏一份 QuickJS Runtime 内存，
               跑几十组样例后 APP 内存暴涨，而且看不出是谁造成的。 */
            runCatching { engine.close() }
        }
    }

    /**
     * 是不是编译错误。
     * 只在**证据确凿**时判 CE，拿不准就按 RE ——
     * 两者用户都会去看错误原文，猜错反而误导。
     */
    private fun looksLikeCompile(err: String?): Boolean {
        if (err.isNullOrBlank()) return false
        return COMPILE_HINTS.any { err.contains(it, ignoreCase = true) }
    }

    fun cancel() { currentJob?.cancel(); currentJob = null }

    val running: Boolean get() = currentJob?.isActive == true

    fun close() {
        cancel()
        scope.cancel()
    }

    companion object {
        /** 单组默认 5 秒，比整体运行的 10 秒短 ——
            判题要跑 N 组，每组都给 10 秒的话最坏要等 10N 秒。 */
        const val DEFAULT_CASE_TIMEOUT_MS = 5_000L

        private val COMPILE_HINTS = listOf(
            "语法错误", "编译错误", "syntax error", "compile error",
            "未定义的函数", "暂不支持的语句", "期望"
        )
    }
}
