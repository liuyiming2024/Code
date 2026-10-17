package io.code.app.editor

/* ============================================================
   语法高亮（纯算法，不依赖任何 UI 库）
   ------------------------------------------------------------
   为什么**不**用正则替换来上色：
     正则做高亮有个经典死结 —— 它分不清引号里的 "//" 和真正的注释，
     于是 `printf("a//b")` 会把半个字符串涂成注释色。
     一旦串了色，后面所有的引号配对就全错位，整屏花掉。
     正确做法只有一种：**单次线性扫描**，按"当前处于什么上下文"推进。

   ---------- 两条必须守住的边界 ----------
   1. **token 必须首尾相接、完整覆盖全文**（无空隙、无重叠）。
      有空隙那一段就没颜色（闪一下），有重叠则后写的样式会盖掉前面的。
      下面的循环每轮都把 i 推进"恰好一个 token 的长度"，所以天然连续。
      测试里逐条断言了这一点。

   2. **未闭合的字符串不吞掉后面的行**。
      `a = "abc` 少写一个引号，如果一路扫到文件末尾，
      那么后面几百行全部变成字符串色 —— 用户看到的是"整个文件坏了"，
      而实际只是这一行少个引号。
      所以单引号/双引号遇到换行就**在该行末尾收住**。
      三引号（Python）除外：它本来就是跨行的，那就扫到文件末。

   ---------- 为什么 Plain 也要产 token ----------
   为了上面第 1 条（覆盖全文）。最后做一次相邻的 Plain 合并，
   免得几千个单字符 token 拖慢渲染。

   ---------- 语言判定 ----------
   按扩展名，不 sniff 内容。扩展名对不上就当纯文本（不涂色）——
   涂错色比不涂色更糟：用户会以为是自己的代码写错了。
   ============================================================ */

enum class TokType { Plain, Comment, String, Number, Keyword, Type, Func }

data class Tok(val start: Int, val end: Int, val type: TokType)

object Highlighter {

    private val CPP = setOf(
        "if", "else", "for", "while", "do", "return", "break", "continue", "switch",
        "case", "default", "goto", "struct", "union", "enum", "typedef", "const",
        "static", "extern", "volatile", "inline", "public", "private", "protected",
        "virtual", "template", "typename", "namespace", "using", "new", "delete",
        "try", "catch", "throw", "sizeof", "nullptr", "true", "false", "this",
        "operator", "friend", "explicit", "const_cast", "static_cast", "reinterpret_cast"
    )
    private val CPP_T = setOf(
        "int", "char", "float", "double", "void", "bool", "long", "short",
        "unsigned", "signed", "auto", "size_t", "string", "vector", "map", "set",
        "pair", "list", "deque", "array", "stack", "queue", "iostream"
    )
    private val PY = setOf(
        "def", "class", "if", "elif", "else", "for", "while", "return", "break",
        "continue", "pass", "import", "from", "as", "try", "except", "finally",
        "raise", "with", "lambda", "global", "nonlocal", "assert", "del", "yield",
        "async", "await", "True", "False", "None", "and", "or", "not", "in", "is"
    )
    private val PY_T = setOf("str", "int", "float", "bool", "list", "dict", "set", "tuple", "print")
    private val JS = setOf(
        "var", "let", "const", "function", "class", "if", "else", "for", "while",
        "do", "return", "break", "continue", "switch", "case", "default", "new",
        "delete", "try", "catch", "finally", "throw", "typeof", "instanceof",
        "this", "true", "false", "null", "undefined", "async", "await", "yield",
        "import", "export", "extends", "super"
    )
    private val JS_T = setOf("String", "Number", "Boolean", "Array", "Object", "Math", "JSON", "Promise")

    /** 扩展名 → 语言代号；认不出返回 ""（不涂色）。 */
    fun langOf(pathOrExt: String): String {
        val ext = pathOrExt.substringAfterLast('.', pathOrExt).lowercase()
            .let { if (it == pathOrExt.lowercase() && !pathOrExt.contains('.')) "" else it }
        return when (ext) {
            "c", "cc", "cpp", "cxx", "h", "hpp" -> "cpp"
            "py" -> "py"
            "js", "mjs", "ts" -> "js"
            else -> ""
        }
    }

    fun keywordsOf(lang: String): Set<String> = when (lang) {
        "cpp" -> CPP; "py" -> PY; "js" -> JS; else -> emptySet()
    }
    fun typesOf(lang: String): Set<String> = when (lang) {
        "cpp" -> CPP_T; "py" -> PY_T; "js" -> JS_T; else -> emptySet()
    }

    /** 单次线性扫描。返回的 token 首尾相接、覆盖 [0, src.length)。 */
    fun highlight(src: String, lang: String): List<Tok> {
        val out = ArrayList<Tok>()
        val n = src.length
        if (n == 0 || lang.isEmpty()) return out

        val kw = keywordsOf(lang)
        val ty = typesOf(lang)
        val hashComment = (lang == "py")
        val triple = (lang == "py")

        var i = 0
        while (i < n) {
            val c = src[i]

            /* --- 行注释：// 或（Python）# --- */
            if ((c == '/' && i + 1 < n && src[i + 1] == '/') || (hashComment && c == '#')) {
                var j = i
                while (j < n && src[j] != '\n') j++
                out.add(Tok(i, j, TokType.Comment)); i = j; continue
            }

            /* --- 块注释 /* */ --- */
            if (c == '/' && i + 1 < n && src[i + 1] == '*') {
                val close = src.indexOf("*/", i + 2)
                val j = if (close < 0) n else close + 2
                out.add(Tok(i, j, TokType.Comment)); i = j; continue
            }

            /* --- Python 三引号 --- */
            if (triple && (src.startsWith("\"\"\"", i) || src.startsWith("'''", i))) {
                val q = src.substring(i, i + 3)
                val close = src.indexOf(q, i + 3)
                val j = if (close < 0) n else close + 3
                out.add(Tok(i, j, TokType.String)); i = j; continue
            }

            /* --- 字符串。\ 转义跳过下一个字符；遇换行则收住（见顶部第 2 条） --- */
            if (c == '"' || c == '\'') {
                var j = i + 1
                while (j < n) {
                    when {
                        src[j] == '\\' -> j += 2
                        src[j] == c -> { j++; break }
                        src[j] == '\n' -> break
                        else -> j++
                    }
                }
                val e = minOf(j, n)
                out.add(Tok(i, e, TokType.String)); i = e; continue
            }

            /* --- 数字：123 / 1.5 / 0x1f / 1e+5 / .5 --- */
            if (c.isDigit() || (c == '.' && i + 1 < n && src[i + 1].isDigit())) {
                var j = i + 1
                while (j < n) {
                    val ch = src[j]
                    val prev = src[j - 1]
                    val ok = ch.isDigit() || ch == '.' || ch == '_' || ch.isLetter() ||
                        ((prev == 'e' || prev == 'E') && (ch == '+' || ch == '-'))
                    if (!ok) break
                    j++
                }
                out.add(Tok(i, j, TokType.Number)); i = j; continue
            }

            /* --- 标识符 / 关键字 / 函数名 --- */
            if (c.isLetter() || c == '_') {
                var j = i
                while (j < n && (src[j].isLetterOrDigit() || src[j] == '_')) j++
                val w = src.substring(i, j)
                val type = when {
                    kw.contains(w) -> TokType.Keyword
                    ty.contains(w) -> TokType.Type
                    else -> {
                        var k = j
                        while (k < n && (src[k] == ' ' || src[k] == '\t')) k++
                        if (k < n && src[k] == '(') TokType.Func else TokType.Plain
                    }
                }
                out.add(Tok(i, j, type)); i = j; continue
            }

            out.add(Tok(i, i + 1, TokType.Plain)); i++
        }

        /* 合并相邻的 Plain —— 否则每个标点都是一个 token，渲染时白建几千个对象 */
        val merged = ArrayList<Tok>(out.size)
        for (t in out) {
            val last = merged.lastOrNull()
            if (last != null && last.type == TokType.Plain && t.type == TokType.Plain && last.end == t.start) {
                merged[merged.size - 1] = Tok(last.start, t.end, TokType.Plain)
            } else {
                merged.add(t)
            }
        }
        return merged
    }
}
