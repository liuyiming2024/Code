package io.code.app.judge

/* ============================================================
   判题的纯函数层
   ------------------------------------------------------------
   这一层**不碰引擎、不碰 UI**，全是纯函数，所以能脱离 Android 测试
   （tests/judge-ops-test.py 复刻同样逻辑对拍）。

   ---------- 最重要的一条：输出比对必须归一化 ----------
   逐字节比对会**大量误报 WA**：

     · 程序最后多打一个换行（绝大多数都这样）
     · 行尾多了空格
     · Windows 换行 \r\n

   不处理的话，用户看到 WA 会去查自己的算法 ——
   而算法根本没错。这种误报比漏报更浪费时间。

   ---------- 归一化的三条边界（写反一条就是 bug） ----------
   ① 统一 \r\n → \n        ✅ 必须
   ② 去掉**末尾**多余换行  ✅ 必须
   ③ 每行去掉**行尾**空格  ✅ 必须

   而下面这些**绝不能做**：
   ✗ 去行首空格 —— 缩进是有意义的（比如输出金字塔）
   ✗ 去掉中间的空行 —— 那是输出的一部分
   ✗ 忽略大小写 —— 题目要求什么就是什么
   ✗ 整体 trim —— 会吃掉首行有意义的空格

   ---------- 为什么 TLE 要单独判定 ----------
   TLE 和 WA 长得完全不一样：
     · WA 是"跑完了，答案不对"
     · TLE 是"没跑完，被终止了"
   混在一起报"没通过"，用户会去改算法，而实际要改的是复杂度。
   ============================================================ */

/** 单组样例的结果判定。 */
enum class Verdict {
    /** 通过 */
    AC,
    /** 答案错误：跑完了，输出对不上 */
    WA,
    /** 超时：没跑完，被强制终止 */
    TLE,
    /** 运行错误 */
    RE,
    /** 编译错误 */
    CE,
    /** 结果未知（引擎缺失等）。不假装通过。 */
    UNKNOWN;

    /** 给用户的中文名。不要直接显示枚举名。 */
    val label: String
        get() = when (this) {
            AC -> "通过"
            WA -> "答案错误"
            TLE -> "超时"
            RE -> "运行错误"
            CE -> "编译错误"
            UNKNOWN -> "结果未知"
        }
}

/** 一组测试样例。 */
data class JudgeCase(
    val input: String = "",
    val expected: String = ""
) {
    /** 空样例（既无输入也无期望）没有意义，UI 要拦掉。 */
    val isEmpty: Boolean get() = input.isBlank() && expected.isBlank()
}

/** 一组样例跑出来的结果。 */
data class CaseResult(
    /** 第几组，从 1 开始 —— 用户数样例是从 1 数的。 */
    val index: Int,
    val verdict: Verdict,
    /** 实际输出（原始，未归一化，方便用户对照）。 */
    val actual: String,
    val expected: String,
    val ms: Long = 0,
    /** 错误信息（RE / CE 时才有）。 */
    val error: String? = null
)

object JudgeOps {

    /* ---------- 归一化 ---------- */

    /**
     * 归一化输出，用于比对。
     *
     * 三步，顺序不能变：先统一换行，再去行尾空格，最后去末尾换行。
     * **先去末尾换行再去行尾空格是错的** ——
     * 末尾那行如果是 "...  \n"，去掉 \n 后变成 "...  "，
     * 再去行尾空格才对；反过来做的话，
     * 行尾空格在"末尾"判断之后才处理，会残留一个空行。
     */
    fun normalize(s: String): String {
        if (s.isEmpty()) return ""
        val unified = s.replace("\r\n", "\n").replace('\r', '\n')
        return unified
            .split('\n')
            .map { it.trimEnd() }              // 行尾空格（不含行首）
            .joinToString("\n")
            .trimEnd('\n')                      // 只去末尾的换行
    }

    /** 比对。null 安全 —— 引擎可能返回空。 */
    fun compare(actual: String?, expected: String?): Boolean =
        normalize(actual ?: "") == normalize(expected ?: "")

    /* ---------- 样例解析 ---------- */

    /**
     * 从文本解析样例。
     *
     * 格式（与网页端一致，两端行为要对齐）：
     * ```
     * --- input
     * 1 2
     * --- expected
     * 3
     * ===
     * --- input
     * 3 4
     * --- expected
     * 7
     * ```
     *
     * ---------- 为什么用显式分隔符而不是"一行输入一行输出" ----------
     * 输入输出都可能**多行**，靠行数猜必然出错，
     * 而且错了不报错 —— 用户会看到莫名其妙的 WA。
     * 显式分隔符虽然要多打几个字，但**错的时候看得出来**。
     */
    fun parseCases(text: String): List<JudgeCase> {
        if (text.isBlank()) return emptyList()
        /* ⚠ 必须去掉文本末尾的**一个**换行。
           序列化（formatCases）在最后一组后会留一个 \n，
           不去掉的话它会被当成内容行，于是最后一组凭空多出一行 ——
           表现为：用户没改样例，每次打开却多一个空行，越存越乱。
           （Kotlin 侧测试的往返用例就是这么抓到它的。）

           只去**一个**，且不碰中间：
           样例里真实的空行是有意义的，多删就改变了题目。
           removeSuffix 只删末尾一处，正合适。 */
        val body = text.removeSuffix("\n")
        val out = mutableListOf<JudgeCase>()
        var input = StringBuilder()
        var expected = StringBuilder()
        var target: StringBuilder? = null

        for (raw in body.split('\n')) {
            val line = raw.trimEnd()
            when {
                line.startsWith("---") -> {
                    val tag = line.removePrefix("---").trim().lowercase()
                    target = when {
                        tag.startsWith("in") -> input          // input / 输入
                        tag.startsWith("exp") || tag.startsWith("out") -> expected
                        else -> null                            // 认不出的标签，忽略内容
                    }
                }
                line == "===" -> {
                    out.add(JudgeCase(input.toString(), expected.toString()))
                    input = StringBuilder()
                    expected = StringBuilder()
                    target = null
                }
                else -> target?.append(line)?.append('\n')
            }
        }
        // 最后一组可能没有 === 收尾
        if (input.isNotEmpty() || expected.isNotEmpty()) {
            out.add(JudgeCase(input.toString(), expected.toString()))
        }
        return out
    }

    /** 反向：把样例写回文本。解析→序列化要能还原，否则用户每次打开都在变。 */
    fun formatCases(cases: List<JudgeCase>): String = buildString {
        cases.forEachIndexed { i, c ->
            if (i > 0) appendLine("===")
            appendLine("--- input")
            appendLine(c.input)
            appendLine("--- expected")
            appendLine(c.expected)
        }
    }

    /* ---------- 汇总 ---------- */

    /** 全部通过才算通过。有一组 UNKNOWN 就不能说通过 —— 那等于撒谎。 */
    fun allPassed(results: List<CaseResult>): Boolean =
        results.isNotEmpty() && results.all { it.verdict == Verdict.AC }

    /** 汇总成一句话，给面板顶部显示。 */
    fun summary(results: List<CaseResult>): String {
        if (results.isEmpty()) return "还没有样例"
        val n = results.size
        val ac = results.count { it.verdict == Verdict.AC }
        return if (ac == n) "全部通过（$n/$n）"
        else "$ac/$n 通过"
    }

    /**
     * 定位第一组没通过的。
     * 用户最关心的是"从哪一组开始错的"，报最后一组没意义。
     */
    fun firstFailure(results: List<CaseResult>): CaseResult? =
        results.firstOrNull { it.verdict != Verdict.AC }

    /** 把一组结果格式化成可读文本。RE/CE 时不显示输出对比（没有输出可比）。 */
    fun formatCase(r: CaseResult): String = buildString {
        append("第 ${r.index} 组：${r.verdict.label}")
        if (r.ms > 0) append("（${r.ms} ms）")
        appendLine()
        when (r.verdict) {
            Verdict.RE, Verdict.CE -> {
                appendLine(r.error ?: "无详细信息")
            }
            Verdict.TLE -> {
                appendLine("跑超时了。输出（可能不完整）：")
                appendLine(brief(r.actual))
            }
            else -> {
                if (r.verdict == Verdict.WA) {
                    appendLine("期望：")
                    appendLine(brief(r.expected))
                    appendLine("实得：")
                } else {
                    appendLine("输出：")
                }
                appendLine(brief(r.actual))
            }
        }
    }

    /** 截断，避免一组超长输出把面板刷爆。 */
    private fun brief(s: String, limit: Int = 800): String {
        if (s.length <= limit) return s.ifEmpty { "（空）" }
        return s.take(limit) + "\n…（已截断，共 ${s.length} 字符）"
    }
}
