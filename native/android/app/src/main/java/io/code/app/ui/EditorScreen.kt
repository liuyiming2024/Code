package io.code.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Menu
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalTextInputService
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.code.app.editor.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.IOException

/* ============================================================
   编辑界面
   ------------------------------------------------------------
   最关键的一行在下面 CompositionLocalProvider：
   把 LocalTextInputService 设成 null，输入法平台通道就不会启动。
   于是系统软键盘**根本不会弹出** —— 这也是 Web 版做不到、
   只能靠"绕过"的事情。

   界面全部是 Compose（原生），没有任何 WebView。
   ============================================================ */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditorScreen(
    fileName: String,
    store: io.code.app.data.FileStore,
    onOpenDrawer: () -> Unit = {},
    onFileChanged: () -> Unit = {}
) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current

    var value by remember {
        mutableStateOf(TextFieldValue(store.read(fileName)))
    }
    var saveState by remember { mutableStateOf<SaveState>(SaveState.Idle) }
    var lastSaved by remember { mutableStateOf(store.read(fileName)) }

    /* 语法高亮。
       lang 按**扩展名**判定，认不出就返回 "" —— 那时不涂任何颜色。
       涂错色比不涂色更糟：用户会以为是自己的代码写错了。 */
    val lang = remember(fileName) { Highlighter.langOf(fileName) }

    /* ⚠ 必须把 value.text 当 key：只 remember(lang) 的话，
       改了文字但语言没变，颜色不会重算 —— 表现是"高亮卡在第一版不动"。 */
    val annotated = remember(value.text, lang) { buildHighlighted(value.text, lang) }

    /* 撤销栈。**换文件必须 reset** ——
       不重置的话，在新文件里撤销会把上一个文件的内容倒进来。
       那种错法用户完全没法理解：他明明只改了一个字，整篇变了。 */
    val history = remember { UndoStack() }
    LaunchedEffect(fileName) {
        val t = store.read(fileName)
        history.reset(t)
        value = TextFieldValue(t)
        lastSaved = t
        saveState = SaveState.Idle
    }

    /* 自动保存：700ms debounce，与 Web 端一致。
       ⚠ 失败必须常驻可见 —— 只弹一次 toast 的话用户在看代码就错过了，
       于是以为存了、其实一直在失败。这条判据来自 Chat 端实测。 */
    LaunchedEffect(value.text) {
        if (value.text == lastSaved) return@LaunchedEffect
        saveState = SaveState.Dirty
        delay(700)
        try {
            store.write(fileName, value.text)
            lastSaved = value.text
            saveState = SaveState.Saved
        } catch (e: IOException) {
            saveState = SaveState.Failed(e.message ?: "写入失败")
        }
    }

    /* 关闭/切后台时立刻落盘。
       Android 上对应 Web 的 beforeunload/pagehide ——
       这里用 DisposableEffect 在离开界面时同步写一次。 */
    DisposableEffect(Unit) {
        onDispose {
            if (value.text != lastSaved) {
                try {
                    store.write(fileName, value.text)
                    lastSaved = value.text
                } catch (_: IOException) { }
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(fileName, fontSize = 15.sp) },
                actions = {
                    IconButton(onClick = {
                        scope.launch {
                            try {
                                store.write(fileName, value.text)
                                lastSaved = value.text
                                saveState = SaveState.Saved
                            } catch (e: IOException) {
                                saveState = SaveState.Failed(e.message ?: "写入失败")
                            }
                        }
                    }) {
                        Icon(Icons.Default.Save, contentDescription = "保存")
                    }
                    IconButton(onClick = onOpenDrawer) {
                        Icon(Icons.Default.Menu, contentDescription = "文件")
                    }
                    IconButton(onClick = { /* 第三阶段接运行时 */ }) {
                        Icon(Icons.Default.PlayArrow, contentDescription = "运行")
                    }
                }
            )
        },
        bottomBar = {
            Column {
                SaveStatusBar(saveState)
                // 原生键盘：系统输入法全程不参与
                CodeKeyboard(
                    indentUnit = DEFAULT_INDENT,
                    onAction = { act ->
                        /* 撤销 / 重做单独处理：它们改的是历史，不是"一次编辑" */
                        if (act == EditAction.Undo) {
                            history.undo(value.text)?.let { value = TextFieldValue(it) }
                            return@CodeKeyboard
                        }
                        if (act == EditAction.Redo) {
                            history.redo()?.let { value = TextFieldValue(it) }
                            return@CodeKeyboard
                        }
                        val before = value.text
                        val next = when (act) {
                            is EditAction.Insert -> insertText(value, act.text)
                            is EditAction.Bracket -> insertBracket(value, act.open, act.close)
                            EditAction.Tab -> insertText(value, DEFAULT_INDENT)
                            EditAction.Enter -> enter(value, DEFAULT_INDENT)
                            EditAction.Backspace -> backspace(value, DEFAULT_INDENT)
                            EditAction.Left -> moveLeft(value)
                            EditAction.Right -> moveRight(value)
                            EditAction.Up -> moveVertical(value, -1)
                            EditAction.Down -> moveVertical(value, 1)
                            EditAction.Home -> home(value)
                            EditAction.End -> end(value)
                            EditAction.SelectAll -> value.copy(
                                selection = androidx.compose.ui.text.TextRange(0, value.text.length)
                            )
                            EditAction.PageUp -> moveVertical(value, -10)
                            EditAction.PageDown -> moveVertical(value, 10)
                            EditAction.Save -> {
                                scope.launch {
                                    try {
                                        store.write(fileName, value.text)
                                        lastSaved = value.text
                                        saveState = SaveState.Saved
                                        onFileChanged()
                                    } catch (e: IOException) {
                                        saveState = SaveState.Failed(e.message ?: "写入失败")
                                    }
                                }
                                value
                            }
                            else -> value   // 复制/粘贴/运行：第三阶段接
                        }
                        /* 记录历史。光标移动也走这里，但 push 内部会
                           比较 before/after，内容没变就不入栈 ——
                           所以不用在这里筛哪些动作"算编辑"。 */
                        val (ds, de) = diffRange(before, next.text)
                        history.push(before, next.text, ds, de, System.currentTimeMillis())
                        value = next
                    }
                )
            }
        }
    ) { pad ->
        /* 把 LocalTextInputService 置空 = 不启动输入法平台通道。
           这是"根本不让系统键盘弹出"的关键，Web 版做不到。 */
        CompositionLocalProvider(LocalTextInputService provides null) {
            BasicTextField(
                value = value,
                /* 用带样式的 AnnotatedString，但**保留光标位置** ——
                   只传 annotated 会把光标弹回开头，表现为"每打一个字光标就跳走"。
                   composition 也要带上，否则输入法/自动纠错会错位。 */
                value = TextFieldValue(annotated, value.selection, value.composition),
                onValueChange = { nv ->
                    val before = value.text
                    val (ds, de) = diffRange(before, nv.text)
                    history.push(before, nv.text, ds, de, System.currentTimeMillis())
                    value = nv
                },
                modifier = Modifier
                    .padding(pad)
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(12.dp),
                textStyle = LocalTextStyle.current.copy(
                    fontFamily = FontFamily.Monospace,
                    fontSize = 14.sp,
                    lineHeight = 20.sp
                )
            )
        }
    }
}

/* 把 token 序列变成带样式的文本。
   只给非 Plain 的段上色 —— Plain 用默认色即可。 */
private fun buildHighlighted(src: String, lang: String) = buildAnnotatedString {
    append(src)
    if (lang.isEmpty()) return@buildAnnotatedString
    for (t in Highlighter.highlight(src, lang)) {
        if (t.type == TokType.Plain) continue
        val st = when (t.type) {
            TokType.Comment -> SpanStyle(color = HL.comment, fontStyle = FontStyle.Italic)
            TokType.String  -> SpanStyle(color = HL.str)
            TokType.Number  -> SpanStyle(color = HL.number)
            TokType.Keyword -> SpanStyle(color = HL.keyword)
            TokType.Type    -> SpanStyle(color = HL.type)
            TokType.Func    -> SpanStyle(color = HL.func)
            else            -> return@buildAnnotatedString.run { } as SpanStyle
        }
        addStyle(st, t.start, t.end)
    }
}

/* 配色集中放一处 —— 散在代码里的话，改主题时必然漏掉一两个。 */
private object HL {
    val keyword = androidx.compose.ui.graphics.Color(0xFFC792EA)
    val type    = androidx.compose.ui.graphics.Color(0xFF82AAFF)
    val str     = androidx.compose.ui.graphics.Color(0xFFC3E88D)
    val number  = androidx.compose.ui.graphics.Color(0xFFF78C6C)
    val comment = androidx.compose.ui.graphics.Color(0xFF6B7A8F)
    val func    = androidx.compose.ui.graphics.Color(0xFF82AAFF)
}

sealed interface SaveState {
    data object Idle : SaveState
    data object Dirty : SaveState
    data object Saved : SaveState
    data class Failed(val reason: String) : SaveState
}

@Composable
private fun SaveStatusBar(state: SaveState) {
    val (text, color) = when (state) {
        SaveState.Idle -> "" to MaterialTheme.colorScheme.onSurfaceVariant
        SaveState.Dirty -> "未保存…" to MaterialTheme.colorScheme.onSurfaceVariant
        SaveState.Saved -> "已保存" to MaterialTheme.colorScheme.onSurfaceVariant
        is SaveState.Failed ->
            // 常驻 + 给出可执行的出路，而不是弹一次就没了
            ("保存失败：${state.reason} —— 请改用「导出备份」" to
                MaterialTheme.colorScheme.error)
    }
    if (text.isNotEmpty()) {
        Text(
            text,
            color = color,
            fontSize = 12.sp,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 3.dp)
        )
    }
}
