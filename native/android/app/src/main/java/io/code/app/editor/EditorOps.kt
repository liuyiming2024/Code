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
