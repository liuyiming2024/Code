package io.code.app.editor

/* ============================================================
   撤销 / 重做栈
   ------------------------------------------------------------
   为什么不用 Compose 自带的 UndoManager：
     它挂在 TextField 内部，换文件、重建界面就没了；
     而且它不给你"合并策略"的控制权 —— 于是打一行字要按十次撤销。

   ---------- 核心难点：合并 ----------
   用户连打 "hello"，如果每个字符一步，撤销就要按 5 次。
   但也不能无脑合并 —— 打完字去别处点一下再打，那是**两步**。

   所以合并的条件必须是"连续的同类编辑"：
     · 类型相同（都是插入 / 都是删除）
     · 新区间紧贴旧区间（插入：新起点 == 旧终点；删除：新终点 == 旧起点）
     · 距上一步不超过 coalesceMs

   第三条是时间窗。只靠前两条的话，用户停了三秒再打，
   也会被并进上一步 —— 而人的预期是"我停了一下，那就是新的一步"。

   ---------- 区间怎么记 ----------
   每一步记 [start, end) 是**受影响的区间**：
     · 插入：end = start + 插入长度
     · 删除：end = 被删区间的右端
   合并就是取并集（min start, max end）—— 插入和删除都一样。

   ⚠ 插入的 end 不能写成 start：那样连打第二个字符时
     "新起点 == 旧终点" 永远不成立，合并形同虚设，
     表现是"撤销一次只退一个字符"，而且不报错，极难发现。

   ---------- 为什么存快照而不是存 diff ----------
   diff（记录"在第 n 行插入了 s"）更快也更省内存，但要求
   每一步都能精确逆运算。本项目里有括号自动配对、缩进自动插入，
   一次按键可能改多处 —— 逆运算写错一处，撤销就变成把文档改坏。

   快照（整篇文本）不会算错。代价是内存，但代码文件通常几十 KB，
   栈深 100 步也就几 MB，可以接受。**正确性优先于内存**。

   ⚠ 重做栈必须在新编辑时清空：
     撤销 → 改了别的 → 再点重做，如果旧的重做分支还在，
     重做出来的内容会和当前文本对不上，等于把文档写坏。
   ============================================================ */

/* ============================================================
   求两篇文本的差异区间 [start, end)
   ------------------------------------------------------------
   给撤销栈用：push 要知道"这次改的是哪一段"。

   ⚠ 必须给公共后缀**设上限**：
     before="aa", after="a"
       公共前缀 = 1，公共后缀 = 1
       但两者加起来 2 > min(2,1)=1 —— 后缀和前缀**重叠**了
     直接用 1 算出来的区间是 [1,1)，是个空区间，
     于是这次删除被当成"插入"，跟退格合并的判断全乱。

   正确做法：后缀最多只能取到 min(len) - 前缀，
   这样 a+b 不超过较短那篇的长度，两边不重叠。
   于是 [1,2) —— 正确识别出"删掉了第 1 个字符"。

   这是纯函数，测试见 tests/diff-range-test.py。
   ============================================================ */
fun diffRange(before: String, after: String): Pair<Int, Int> {
    if (before == after) return 0 to 0
    val maxLen = minOf(before.length, after.length)
    val a = before.commonPrefixWith(after)
    val b = minOf(before.commonSuffixWith(after), maxLen - a)
    return a to (before.length - b)
}

class UndoStack(
    private val limit: Int = 100,
    private val coalesceMs: Long = COALESCE_MS
) {
    companion object { const val COALESCE_MS = 600L }

    /** 一步编辑。text 是这一步**之后**的全文，[start,end) 是受影响区间。 */
    data class Edit(
        val text: String,
        val start: Int,
        val end: Int,
        val insert: Boolean,
        val at: Long
    )

    private val undo = ArrayDeque<Edit>()
    private val redo = ArrayDeque<Edit>()

    /** 栈底之前的那篇文本。撤销到底时回到它。 */
    private var base: String = ""

    fun reset(text: String) {
        undo.clear(); redo.clear(); base = text
    }

    val canUndo: Boolean get() = undo.isNotEmpty()
    val canRedo: Boolean get() = redo.isNotEmpty()
    val depth: Int get() = undo.size

    /**
     * 记录一次编辑。
     * @param before 改动前的全文
     * @param after  改动后的全文
     * @param start  改动起点
     * @param end    改动终点（删除时 > start；插入时传 start 即可）
     * @param now    时间戳（传进来是为了可测试 —— 测试要能"等 3 秒"）
     */
    fun push(before: String, after: String, start: Int, end: Int, now: Long) {
        if (before == after) return
        val insert = end <= start
        val e = Edit(
            after,
            start,
            if (insert) start + (after.length - before.length) else end,
            insert,
            now
        )

        val top = undo.lastOrNull()
        val contiguous = if (insert) e.start == top?.end else e.end == top?.start
        val merge = top != null && top.insert == insert &&
            now - top.at <= coalesceMs && contiguous

        if (merge) {
            undo.removeLast()
            undo.addLast(Edit(after, minOf(top!!.start, e.start), maxOf(top.end, e.end), insert, now))
        } else {
            undo.addLast(e)
            // 超上限就丢最早一步。⚠ 必须同时把 base 推进到它 ——
            // 否则一路撤销到底会撤到一篇已经不在栈里的文本
            while (undo.size > limit) base = undo.removeFirst().text
        }
        redo.clear()
    }

    /** 撤销一步，返回应显示的文本；栈空返回 null。 */
    fun undo(current: String, now: Long = System.currentTimeMillis()): String? {
        val e = undo.removeLastOrNull() ?: return null
        redo.addLast(Edit(current, e.start, e.end, e.insert, now))
        return if (undo.isEmpty()) base else undo.last().text
    }

    /** 重做一步，返回应显示的文本；栈空返回 null。 */
    fun redo(): String? {
        val e = redo.removeLastOrNull() ?: return null
        undo.addLast(e)
        return e.text
    }
}
