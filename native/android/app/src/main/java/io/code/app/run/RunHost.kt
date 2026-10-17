package io.code.app.run

import kotlinx.coroutines.*
import java.util.concurrent.ConcurrentHashMap

/* ============================================================
   运行调度器
   ------------------------------------------------------------
   界面只跟它打交道，不直接碰引擎。分层的理由很实在：
   引擎的生命周期（建、复用、释放）跟 Compose 重组搅在一起的话，
   一次重组就可能多建一个引擎 —— 每个引擎是一整个 QuickJS Runtime，
   泄漏起来是兆字节级的，而且症状是"用久了越来越卡"，
   没人会联想到"重组时多建了个引擎"。

   ---------- 为什么必须显式在后台线程跑 ----------
   解释器是同步的、CPU 密集的。放在主线程跑：
     - 界面直接冻住，连"正在运行"的转圈都渲染不出来
     - 超过 5 秒触发 ANR，系统弹"应用无响应"
   所以一律切 Dispatchers.Default。

   ---------- 为什么同一时刻只允许一个引擎 ----------
   两个引擎同时跑不是不行，但用户看到的输出会交错，
   而且超时判定会互相干扰（两个 deadline 抢同一个中断回调的设计前提）。
   竞赛场景也用不上并发跑两道题。所以排队，后来的**取消前一个**。

   ---------- 为什么引擎要缓存而不是每次新建 ----------
   每次新建要重新 eval 三千多行解释器源码，几百毫秒白等。
   缓存后第二次运行几乎是瞬时的（这也是网页端做过的事）。
   代价：必须记得释放，见 close()。
   ============================================================ */

class RunHost {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** 脚本名 → 引擎。ConcurrentHashMap 是因为 close 可能从别的线程来。 */
    private val engines = ConcurrentHashMap<String, QuickJsRunner>()

    /** 当前正在跑的任务。新任务来时先取消它 —— 见文件头"为什么只许一个"。 */
    @Volatile
    private var currentJob: Job? = null

    /**
     * 运行一段代码。
     * onDone 回调保证在主线程 —— 界面直接在里面改状态即可。
     */
    fun run(
        code: String,
        stdin: String,
        script: String,
        source: String,
        timeoutMs: Long = DEFAULT_TIMEOUT_MS,
        onDone: (RunResult) -> Unit
    ) {
        currentJob?.cancel()

        currentJob = scope.launch {
            val r = runSync(code, stdin, script, source, timeoutMs)
            /* 切回主线程：Compose 的状态只能在主线程改，
               在后台线程改会抛 IllegalArgumentException，
               而且是概率性的（跑得快的那几次反而不崩）—— 极难复现。 */
            withContext(Dispatchers.Main) { onDone(r) }
        }
    }

    /** 同步执行。测试直接调这个，不用等协程。 */
    fun runSync(
        code: String,
        stdin: String,
        script: String,
        source: String,
        timeoutMs: Long = DEFAULT_TIMEOUT_MS
    ): RunResult {
        val t0 = System.currentTimeMillis()
        val engine = engineFor(script, source)
            ?: return RunResult(
                out = "",
                err = "运行时没接上：${QuickJsRunner.loadError() ?: "QuickJS 原生库没编进 APK"}\n" +
                    "装 NDK 后重新构建即可（见 NDK.md）。编辑器不依赖它，照常能用。",
                ms = System.currentTimeMillis() - t0
            )
        return try {
            engine.run(code, stdin, timeoutMs)
        } catch (e: Throwable) {
            /* 引擎抛异常不能让应用崩。最常见的两种：
               ① 引擎已释放（界面关了但任务还在跑）
               ② 解释器内部未捕获的错误
               都转成一条能看懂的结果。 */
            RunResult(
                out = "",
                err = "运行出错：${e.message ?: e}",
                ms = System.currentTimeMillis() - t0
            )
        }
    }

    private fun engineFor(script: String, source: String): QuickJsRunner? {
        engines[script]?.let { return it }
        val e = QuickJsRunner.create(script, source) ?: return null
        engines[script] = e
        return e
    }

    /** 取消正在跑的。点"停止"时用。 */
    fun cancel() { currentJob?.cancel(); currentJob = null }

    val running: Boolean get() = currentJob?.isActive == true

    /**
     * 释放全部引擎。
     * 必须调 —— 不调的话 QuickJS Runtime 一直占着内存。
     * 放在 Activity.onDestroy 里。
     */
    fun close() {
        cancel()
        engines.values.forEach { runCatching { it.close() } }
        engines.clear()
        scope.cancel()
    }

    companion object {
        /** 默认 10 秒。竞赛题在本机跑得比真编译器慢，但也不会太离谱。 */
        const val DEFAULT_TIMEOUT_MS = 10_000L
    }
}
