package io.code.app.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.code.app.run.RunResult

/* ============================================================
   运行面板（底部）
   ------------------------------------------------------------
   三条必须遵守的界面规则，都来自实测过的问题：

   ① **输入不能被吞**
      竞赛题几乎都要读输入。没有输入区的话程序一开头就遇到 EOF，
      用户会以为自己的代码读错了 —— 实际上是他根本没地方给输入。

   ② **错误要红、超时要明说**
      超时和"答案错"长得完全不一样。跑 10 秒被终止却只显示空白，
      用户会以为程序没输出，于是去改代码 —— 越改越远。

   ③ **能力边界要摆在眼前**
      caveat 只在**首次运行后**显示，且可关掉。
      一直挂着是噪音；一次都不说则是欺骗（用户写了不支持的语法，
      会以为编译器坏了，然后花时间查自己的代码）。

   ---------- 为什么输入区不用系统键盘 ----------
   整个界面为了不弹系统键盘，把 LocalTextInputService 设成了 null。
   于是输入区**也**不能用系统键盘 —— 这是这个设计的连带代价，
   必须明确处理，否则用户点输入区没反应，会以为输入框坏了。
   做法：输入区聚焦时，把自研 CodeKeyboard 的按键**转投**给它
   （见 EditorScreen 里 onKeyTarget 的分派）。
   ============================================================ */

/** 运行面板的显示状态。抽出来是因为它要跨重组存活。 */
class RunState {
    var visible by mutableStateOf(false)
    var running by mutableStateOf(false)
    var result by mutableStateOf<RunResult?>(null)
    /* 用 TextFieldValue 而不是 String：
       自研键盘的编辑函数（退格删缩进、上下移保持列号…）全部吃 TextFieldValue。
       存 String 的话这些函数在输入区就得重写一遍，
       而"代码区能用的操作在输入区突然变了"本身就是 bug。 */
    var stdin by mutableStateOf(androidx.compose.ui.text.input.TextFieldValue(""))
    var stdinFocused by mutableStateOf(false)
    var caveatDismissed by mutableStateOf(false)

    /** 首次出结果时给一次边界提示，之后不再打扰。 */
    val showCaveat: Boolean get() = result?.caveat != null && !caveatDismissed
}

@Composable
fun rememberRunState(): RunState = remember { RunState() }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RunPanel(
    state: RunState,
    onRun: () -> Unit,
    onStop: () -> Unit,
    onStdinAction: (io.code.app.editor.EditAction) -> Unit,
    modifier: Modifier = Modifier
) {
    if (!state.visible) return

    Surface(
        tonalElevation = 2.dp,
        modifier = modifier.fillMaxWidth().heightIn(min = 120.dp, max = 300.dp)
    ) {
        Column(Modifier.padding(horizontal = 10.dp, vertical = 6.dp)) {

            /* ---- 第一行：按钮 + 状态 ---- */
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { if (state.running) onStop() else onRun() }) {
                    Icon(
                        if (state.running) Icons.Default.Close else Icons.Default.PlayArrow,
                        contentDescription = if (state.running) "停止" else "运行"
                    )
                }
                Text("运行", fontSize = 13.sp)
                Spacer(Modifier.width(8.dp))
                if (state.running) {
                    CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(6.dp))
                    Text("运行中…", fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
                } else {
                    state.result?.let { r ->
                        Text(
                            when {
                                r.timeout -> "超时（已终止）"
                                r.err != null -> "出错了"
                                else -> "完成 · ${r.ms} ms"
                            },
                            fontSize = 12.sp,
                            color = if (r.ok) MaterialTheme.colorScheme.onSurfaceVariant
                                    else MaterialTheme.colorScheme.error
                        )
                    }
                }
                Spacer(Modifier.weight(1f))
                TextButton(onClick = { state.stdinFocused = !state.stdinFocused }) {
                    Text(if (state.stdinFocused) "输入中" else "输入", fontSize = 12.sp)
                }
                TextButton(onClick = { state.visible = false }) { Text("收起", fontSize = 12.sp) }
            }

            /* ---- 输入区：聚焦时用自研键盘编辑 ---- */
            if (state.stdinFocused) {
                OutlinedTextField(
                    value = state.stdin,
                    onValueChange = { },   /* 只读：输入全部由自研键盘给 */
                    readOnly = true,
                    label = { Text("程序输入（stdin）", fontSize = 11.sp) },
                    textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace, fontSize = 12.sp),
                    modifier = Modifier.fillMaxWidth().heightIn(max = 90.dp).verticalScroll(rememberScrollState()),
                    /* 点一下就交给自研键盘；系统键盘不会弹（全局禁用） */
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = MaterialTheme.colorScheme.primary
                    )
                )
            }

            /* ---- 能力边界：只提示一次，可关 ---- */
            if (state.showCaveat) {
                Row(
                    Modifier.fillMaxWidth().padding(vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        state.result?.caveat ?: "",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f)
                    )
                    TextButton(onClick = { state.caveatDismissed = true }) {
                        Text("知道了", fontSize = 11.sp)
                    }
                }
            }

            /* ---- 输出 ---- */
            val r = state.result
            Box(
                Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .horizontalScroll(rememberScrollState())
            ) {
                when {
                    r == null && !state.running ->
                        Text("点「运行」执行。需要读输入的话先点「输入」。",
                            fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    r?.timeout == true ->
                        Text("超过时限被终止。\n可能是死循环，也可能是数据太大跑不完。",
                            fontSize = 12.sp, color = MaterialTheme.colorScheme.error)
                    r?.err != null ->
                        Text(r.err!!, fontSize = 12.sp, fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.error)
                    r != null ->
                        Text(
                            if (r.out.isEmpty()) "（程序没有输出）" else r.out,
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                            color = if (r.out.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant
                                    else Color.Unspecified
                        )
                }
            }
        }
    }
}
