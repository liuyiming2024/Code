package io.code.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.background
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.LocalTextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.code.app.editor.EditAction
import io.code.app.editor.*
import io.code.app.judge.*

/* ============================================================
   判题面板（底部，与「运行」并列）
   ------------------------------------------------------------
   ---------- 为什么判题要单独一页，而不是塞进输出区 ----------
   样例是**输入**，输出是**结果**。混在一栏里会出现：
   用户改了样例，输出区却还显示上一次的结果 ——
   他分不清自己看到的是新的还是旧的。

   ---------- 样例编辑区同样不能用系统键盘 ----------
   和输入区完全一样的问题：全局禁用了系统输入法，
   样例区没有别的输入途径。不转投的话字符全进代码里，
   而样例区永远是空的 —— 用户只会以为样例区坏了。
   转投逻辑见 EditorScreen 的 onAction 分派。

   ---------- 为什么样例要持久化 ----------
   竞赛题的样例是题目的一部分，不是临时数据。
   不存的话每次打开 APP 都要重敲一遍，
   而重敲容易敲错 —— 敲错了会得到莫名其妙的 WA。
   ============================================================ */

/** 判题面板状态。跨重组存活，所以抽成类。 */
class JudgeState {
    var visible by mutableStateOf(false)
    var running by mutableStateOf(false)
    /** 样例原文。用 TextFieldValue —— 自研键盘的编辑函数吃的是它。 */
    var casesText by mutableStateOf(TextFieldValue(""))
    var casesFocused by mutableStateOf(false)
    var results by mutableStateOf<List<CaseResult>>(emptyList())
    /** 整体结论。null = 还没跑过。 */
    var report by mutableStateOf<JudgeReport?>(null)
    /** 引擎缺失等情况下的一句说明。 */
    var error by mutableStateOf<String?>(null)

    fun reset() {
        results = emptyList()
        report = null
        error = null
    }

    /** 当前解析出的样例。解析失败（为空）时 UI 要拦，不能拿空列表去跑。 */
    val cases: List<JudgeCase> get() = JudgeOps.parseCases(casesText.text)
}

@Composable
fun rememberJudgeState(): JudgeState = remember { JudgeState() }

/** 样例的存储路径：跟源文件放在一起，加 .cases 后缀。 */
internal fun casesPathFor(sourcePath: String): String = "$sourcePath.cases"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun JudgePanel(
    state: JudgeState,
    onJudge: () -> Unit,
    onStop: () -> Unit,
    onCasesAction: (EditAction) -> Unit,
    modifier: Modifier = Modifier
) {
    if (!state.visible) return

    val scroll = rememberScrollState()

    Surface(
        tonalElevation = 2.dp,
        modifier = modifier.fillMaxWidth().heightIn(min = 120.dp, max = 320.dp)
    ) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {

            /* ---- 第一行：按钮 + 汇总 ---- */
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { if (state.running) onStop() else onJudge() }) {
                    Icon(
                        if (state.running) Icons.Default.Close else Icons.Default.Check,
                        contentDescription = if (state.running) "停止" else "判题"
                    )
                }
                Text("判题", fontSize = 13.sp)
                Spacer(Modifier.width(8.dp))
                if (state.running) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(6.dp))
                    Text("判题中…", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                } else {
                    state.report?.let { rep ->
                        Text(
                            rep.summary,
                            fontSize = 12.sp,
                            color = if (rep.allPassed) MaterialTheme.colorScheme.primary
                            else MaterialTheme.colorScheme.error
                        )
                    } ?: run {
                        val n = state.cases.size
                        Text(
                            if (n == 0) "还没有样例" else "$n 组样例",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            state.error?.let {
                Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.error)
            }

            /* ---- 样例输入区 ---- */
            /* 用 BasicTextField 而不是 TextField：
               后者自带一套指针/IME 逻辑，跟我们全局禁用的输入法打架，
               表现为点了没光标、或者系统键盘意外弹出。 */
            Box(
                Modifier
                    .fillMaxWidth()
                    .weight(1f, fill = false)
                    .heightIn(min = 60.dp, max = 130.dp)
                    .verticalScroll(rememberScrollState())
            ) {
                BasicTextField(
                    value = state.casesText,
                    onValueChange = { state.casesText = it },
                    modifier = Modifier.fillMaxWidth(),
                    textStyle = LocalTextStyle.current.copy(
                        fontFamily = FontFamily.Monospace, fontSize = 12.sp
                    ),
                    decorationBox = { inner ->
                        if (state.casesText.text.isEmpty()) {
                            Text(
                                SAMPLE_HINT,
                                fontSize = 11.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        inner()
                    }
                )
            }

            /* ---- 结果 ---- */
            if (state.results.isNotEmpty()) {
                /* 不用 Divider：它在 material3 各版本间改过名（Divider → HorizontalDivider），
                   写死会编译不过。用一条带背景色的细条代替，任何版本都能编。 */
                Spacer(
                    Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .padding(vertical = 0.dp)
                        .background(MaterialTheme.colorScheme.outlineVariant)
                )
                Column(Modifier.weight(1f).verticalScroll(scroll)) {
                    state.results.forEach { r ->
                        Row(verticalAlignment = Alignment.Top) {
                            Text(
                                r.verdict.label,
                                fontSize = 12.sp,
                                color = verdictColor(r.verdict),
                                modifier = Modifier.width(64.dp)
                            )
                            Text(
                                "第 ${r.index} 组" + if (r.ms > 0) " · ${r.ms}ms" else "",
                                fontSize = 11.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        if (r.verdict != Verdict.AC) {
                            Text(
                                JudgeOps.formatCase(r).substringAfter('\n'),
                                fontSize = 11.sp,
                                fontFamily = FontFamily.Monospace,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(start = 8.dp, bottom = 4.dp)
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun verdictColor(v: Verdict) = when (v) {
    Verdict.AC -> MaterialTheme.colorScheme.primary
    Verdict.WA, Verdict.RE, Verdict.CE -> MaterialTheme.colorScheme.error
    Verdict.TLE -> MaterialTheme.colorScheme.error
    Verdict.UNKNOWN -> MaterialTheme.colorScheme.onSurfaceVariant
}

/**
 * 把按键转投到样例编辑区。
 * 复用 applyEdit —— 代码区能用的操作（退格删缩进、上下移保持列号）
 * 在样例区必须一样，否则"换个框就变了"本身就是 bug。
 */
internal fun applyToCases(v: TextFieldValue, act: EditAction): TextFieldValue = when (act) {
    is EditAction.Insert   -> io.code.app.editor.insertText(v, act.text)
    is EditAction.Bracket  -> io.code.app.editor.insertBracket(v, act.open, act.close)
    EditAction.Tab         -> io.code.app.editor.insertText(v, DEFAULT_INDENT)
    EditAction.Enter       -> io.code.app.editor.enter(v, DEFAULT_INDENT)
    EditAction.Backspace   -> io.code.app.editor.backspace(v, DEFAULT_INDENT)
    EditAction.Left        -> io.code.app.editor.moveLeft(v)
    EditAction.Right       -> io.code.app.editor.moveRight(v)
    EditAction.Up          -> io.code.app.editor.moveVertical(v, -1)
    EditAction.Down        -> io.code.app.editor.moveVertical(v, 1)
    EditAction.Home        -> io.code.app.editor.home(v)
    EditAction.End         -> io.code.app.editor.end(v)
    EditAction.SelectAll   -> v.copy(selection = androidx.compose.ui.text.TextRange(0, v.text.length))
    EditAction.PageUp      -> io.code.app.editor.moveVertical(v, -10)
    EditAction.PageDown    -> io.code.app.editor.moveVertical(v, 10)
    /* 样例区没有历史栈，撤销在这里没意义 —— 吞掉而不是让键盘报错。 */
    EditAction.Undo, EditAction.Redo -> v
    EditAction.Copy, EditAction.Cut, EditAction.Paste -> v
    EditAction.Save, EditAction.Run, EditAction.Escape -> v
}

private const val SAMPLE_HINT = "样例格式：\n--- input\n（输入）\n--- expected\n（期望输出）\n===\n（下一组）"
