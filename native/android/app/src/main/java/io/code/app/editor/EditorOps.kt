package io.code.app.editor

import androidx.compose.ui.text.input.TextFieldValue

/* ============================================================
   编辑器文本操作 —— 纯函数，不碰 UI
   ------------------------------------------------------------
   为什么要单独抽出来：
     键盘只负责"发了什么动作"，具体怎么改文本全在这里。
     纯函数意味着可以脱离 Android 单测，不用起模拟器。

   所有函数都是 (TextFieldValue, 参数) -> TextFieldValue，
   不修改入参，方便撤销栈存快照。
   ============================================================ */

/** Tab 插入的内容。竞赛代码里 4 空格比制表符安全（OJ 显示一致）。 */
const val DEFAULT_INDENT = "    "

fun insertText(value: TextFieldValue, text: String): TextFieldValue {
    val sel = value.selection
    val s = value.text
    val lo = minOf(sel.start, sel.end).coerceIn(0, s.length)
    val hi = maxOf(sel.start, sel.end).coerceIn(0, s.length)
    val next = s.substring(0, lo) + text + s.substring(hi)
    val caret = lo + text.length
    return value.copy(text = next, selection = androidx.compose.ui.text.TextRange(caret))
}

/** 成对括号：插入 "()" 但光标停在中间。 */
fun insertBracket(value: TextFieldValue, open: String, close: String): TextFieldValue {
    val sel = value.selection
    val s = value.text
    val lo = minOf(sel.start, sel.end).coerceIn(0, s.length)
    val hi = maxOf(sel.start, sel.end).coerceIn(0, s.length)

    // 有选区时，用括号把选区包起来（常见需求：给一段表达式加括号）
    val selected = s.substring(lo, hi)
    if (selected.isNotEmpty()) {
        val next = s.substring(0, lo) + open + selected + close + s.substring(hi)
        val caret = lo + open.length + selected.length
        return value.copy(text = next, selection = androidx.compose.ui.text.TextRange(caret))
    }

    // 光标右边已经是空白或闭括号时，自动跳过补的那个闭括号 ——
    // 否则会出现 "())" 这种多余括号，用户还得手动删。
    val after = s.getOrNull(lo)
    if (after != null && (after.isWhitespace() || after in ")]}>")) {
        val next = s.substring(0, lo) + open + close + s.substring(lo)
        return value.copy(
            text = next,
            selection = androidx.compose.ui.text.TextRange(lo + open.length)
        )
    }
    return insertText(value, open + close).let { inserted ->
        // 光标退回到两个括号中间
        inserted.copy(selection = androidx.compose.ui.text.TextRange(lo + open.length))
    }
}

fun backspace(value: TextFieldValue, indent: String = DEFAULT_INDENT): TextFieldValue {
    val s = value.text
    val sel = value.selection
    if (sel.start != sel.end) return deleteSelection(value)

    val lo = sel.start.coerceIn(0, s.length)
    if (lo == 0) return value

    // 光标前面正好是一个完整缩进单位时，一次删掉整个缩进。
    // 逐个空格删 4 次是写代码时最常见的烦躁点。
    val unitLen = indent.length
    if (unitLen > 1 && lo >= unitLen && s.substring(lo - unitLen, lo) == indent) {
        val next = s.substring(0, lo - unitLen) + s.substring(lo)
        return value.copy(text = next, selection = androidx.compose.ui.text.TextRange(lo - unitLen))
    }

    val next = s.substring(0, lo - 1) + s.substring(lo)
    return value.copy(text = next, selection = androidx.compose.ui.text.TextRange(lo - 1))
}

fun deleteSelection(value: TextFieldValue): TextFieldValue {
    val s = value.text
    val lo = minOf(value.selection.start, value.selection.end).coerceIn(0, s.length)
    val hi = maxOf(value.selection.start, value.selection.end).coerceIn(0, s.length)
    val next = s.substring(0, lo) + s.substring(hi)
    return value.copy(text = next, selection = androidx.compose.ui.text.TextRange(lo))
}

/** 回车：继承当前行的缩进。写代码时这是刚需。 */
fun enter(value: TextFieldValue, indent: String = DEFAULT_INDENT): TextFieldValue {
    val s = value.text
    val lo = minOf(value.selection.start, value.selection.end).coerceIn(0, s.length)
    val hi = maxOf(value.selection.start, value.selection.end).coerceIn(0, s.length)

    val lineStart = s.lastIndexOf('\n', lo - 1).let { if (it < 0) 0 else it + 1 }
    val curLine = s.substring(lineStart, lo)
    val lead = indentOf(curLine)

    // 行尾是 { : ( 时，新行再多缩进一级
    val trimmed = curLine.trimEnd()
    val extra = if (trimmed.endsWith("{") || trimmed.endsWith(":") ||
        trimmed.endsWith("(") || trimmed.endsWith("[")
    ) indent else ""

    val insert = "\n" + lead + extra
    val next = s.substring(0, lo) + insert + s.substring(hi)
    return value.copy(
        text = next,
        selection = androidx.compose.ui.text.TextRange(lo + insert.length)
    )
}

/** 取一行的前导空白 */
fun indentOf(line: String): String {
    var i = 0
    while (i < line.length && (line[i] == ' ' || line[i] == '\t')) i++
    return line.substring(0, i)
}

fun moveLeft(value: TextFieldValue): TextFieldValue =
    value.copy(selection = androidx.compose.ui.text.TextRange((value.selection.end - 1).coerceAtLeast(0)))

fun moveRight(value: TextFieldValue): TextFieldValue =
    value.copy(
        selection = androidx.compose.ui.text.TextRange(
            (value.selection.end + 1).coerceAtMost(value.text.length)
        )
    )

/** 上下移动：按行移动光标，尽量保持列号。 */
fun moveVertical(value: TextFieldValue, delta: Int): TextFieldValue {
    val s = value.text
    val lines = s.split('\n')
    val caret = value.selection.end.coerceIn(0, s.length)

    var line = 0
    var consumed = 0
    for (i in lines.indices) {
        if (caret <= consumed + lines[i].length) { line = i; break }
        consumed += lines[i].length + 1
        line = i + 1
    }
    val col = caret - consumed

    val target = (line + delta).coerceIn(0, lines.lastIndex)
    val newCol = col.coerceAtMost(lines[target].length)
    var pos = 0
    for (i in 0 until target) pos += lines[i].length + 1
    pos += newCol

    return value.copy(selection = androidx.compose.ui.text.TextRange(pos.coerceIn(0, s.length)))
}

fun home(value: TextFieldValue): TextFieldValue {
    val s = value.text
    val caret = value.selection.end.coerceIn(0, s.length)
    val lineStart = s.lastIndexOf('\n', caret - 1).let { if (it < 0) 0 else it + 1 }
    // 第一次按 Home 到行首空白之后，再按才到行首 —— 与主流编辑器一致
    val line = s.substring(lineStart, caret)
    val leadLen = indentOf(line).length
    val target = if (caret == lineStart + leadLen || leadLen == 0) lineStart
                 else lineStart + leadLen
    return value.copy(selection = androidx.compose.ui.text.TextRange(target))
}

fun end(value: TextFieldValue): TextFieldValue {
    val s = value.text
    val caret = value.selection.end.coerceIn(0, s.length)
    val nl = s.indexOf('\n', caret)
    return value.copy(
        selection = androidx.compose.ui.text.TextRange(if (nl < 0) s.length else nl)
    )
}

/* ============================================================
   查找 / 替换 —— 纯函数
   ------------------------------------------------------------
   为什么必须有（不是"锦上添花"）：
     手机上没有 Ctrl+F，也没有鼠标滚轮去扫长文件。
     一个 200 行的竞赛代码，找不到变量在哪就改不动。

   ---------- ⚠⚠ 最关键的一条：偏移量必须**每次重算** ----------
     查找结果是一堆字符偏移。文本一改，这些偏移**全部失效**。
     缓存着不重算，替换就会落在**错误的位置**上：
       用户改了一个变量名 → 点"替换" → 改坏的是别处
     而且**没有任何报错** —— 这是最难查的一类错。

     所以：FindResult 只在 (text, query, caseSensitive) 三者都相同时
     才有效，调用方必须把它当"一次性"的用。

   ---------- 为什么 replaceAll 要**从后往前** ----------
     从前往后替换的话，前面替换完文本长度变了，
     后面记录的偏移量就整体错位。
     从后往前则不影响尚未处理的那些偏移（它们都在前面）。
   ============================================================ */

/** 一次查找的结果。**只在文本没变时有效** —— 见上面注释。 */
data class FindResult(
    /** 所有匹配的位置（按出现顺序）。空查询返回空列表。 */
    val ranges: List<IntRange>,
    /** ranges 里当前聚焦的那个的下标；无匹配时为 -1。 */
    val current: Int
) {
    val count: Int get() = ranges.size
    val hasMatch: Boolean get() = ranges.isNotEmpty()
}

/**
 * 在 [text] 里查找 [query]。
 *
 * - [query] 为空 → 返回空结果（不能当成"匹配全部"，
 *   否则一进搜索框就把整篇都涂上高亮，看起来像卡住了）。
 * - [caseSensitive] 为 false 时按小写比较，但返回的仍是**原文**的偏移。
 */
fun findAll(text: String, query: String, caseSensitive: Boolean = true): FindResult {
    if (query.isEmpty()) return FindResult(emptyList(), -1)
    val hay = if (caseSensitive) text else text.lowercase()
    val needle = if (caseSensitive) query else query.lowercase()
    if (needle.isEmpty()) return FindResult(emptyList(), -1)

    val out = ArrayList<IntRange>()
    var from = 0
    while (from <= hay.length - needle.length) {
        val i = hay.indexOf(needle, from)
        if (i < 0) break
        out.add(i until (i + needle.length))
        /* ⚠ 步进必须是 needle.length 而不是 1：
           用 1 的话，"aa" 里找 "aa" 会在 0 和 1 都命中（重叠），
           计数翻倍，"第 1/3 个"这种显示就对不上。
           重叠匹配这里不需要，C++ / Python 的查找也不重叠。 */
        from = i + needle.length
    }
    return FindResult(out, if (out.isEmpty()) -1 else 0)
}

/** 把 [current] 往后/往前移一个，循环。无匹配时返回 -1。 */
fun stepMatch(r: FindResult, delta: Int): FindResult {
    if (!r.hasMatch) return r
    val n = r.count
    val i = (((r.current + delta) % n) + n) % n
    return r.copy(current = i)
}

/** 把当前匹配项替换成 [replacement]，并把光标放到替换之后。 */
fun replaceCurrent(
    value: TextFieldValue,
    r: FindResult,
    replacement: String
): TextFieldValue {
    if (!r.hasMatch) return value
    val range = r.ranges[r.current]
    /* ⚠ 偏移量可能已失效（调用方传了过期的 FindResult）。
       越界就拒绝，绝不能 clamp —— clamp 会静默改到别处。 */
    if (range.first < 0 || range.last >= value.text.length) return value
    val next = value.text.substring(0, range.first) + replacement +
        value.text.substring(range.last + 1)
    val caret = range.first + replacement.length
    return value.copy(text = next, selection = androidx.compose.ui.text.TextRange(caret))
}

/** 替换全部。**从后往前**，避免前面的替换让后面的偏移错位。 */
fun replaceAll(
    value: TextFieldValue,
    ranges: List<IntRange>,
    replacement: String
): TextFieldValue {
    if (ranges.isEmpty()) return value
    var s = value.text
    for (r in ranges.sortedByDescending { it.first }) {
        if (r.first < 0 || r.last >= s.length) continue
        s = s.substring(0, r.first) + replacement + s.substring(r.last + 1)
    }
    return value.copy(
        text = s,
        selection = androidx.compose.ui.text.TextRange(
            value.selection.start.coerceIn(0, s.length)
        )
    )
}

/** 把第 [i] 个匹配滚动到可见：返回它的起始偏移，越界返回 -1。 */
fun matchStart(r: FindResult, i: Int): Int =
    if (i in r.ranges.indices) r.ranges[i].first else -1
