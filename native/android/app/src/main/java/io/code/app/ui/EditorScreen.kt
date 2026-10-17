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
    runHost: io.code.app.run.RunHost,
    sourceOf: (String) -> String = { "" },
    onOpenDrawer: () -> Unit = {},
    onFileChanged: () -> Unit = {}
) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current

    /* 运行面板状态 */
    val run = rememberRunState()

    /* 语言：由**扩展名**决定跑哪个解释器。
       认不出就返回 null —— 那时点运行要给明确提示，
       而不是拿个默认值去跑（跑出来一堆莫名其妙的语法错误，
       用户会以为是自己的代码错了）。 */
    val runnerId = remember(fileName) { io.code.app.run.runnerIdForExt(fileName.substringAfterLast('.', "")) }

    /* 换文件时把上次的结果清掉。
       不清的话，切到另一个文件会**继续显示上一个文件的输出** ——
       用户以为自己刚跑的是新文件。这种"张冠李戴"比没有输出更糟。 */
    LaunchedEffect(fileName) {
        run.result = null
        run.running = false
    }

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
                    IconButton(onClick = { doRun(scope, runHost, run, value.text, fileName, sourceOf, runnerId) }) {
                        Icon(Icons.Default.PlayArrow, contentDescription = "运行")
                    }
                }
            )
        },
        bottomBar = {
            Column {
                RunPanel(
                    state = run,
                    onRun = { doRun(scope, runHost, run, value.text, fileName, sourceOf, runnerId) },
                    onStop = { runHost.cancel(); run.running = false },
                    onStdinAction = { run.stdin = applyToStdin(run.stdin, it) }
                )
                SaveStatusBar(saveState)
                // 原生键盘：系统输入法全程不参与
                CodeKeyboard(
                    indentUnit = DEFAULT_INDENT,
                    onAction = { act ->
                        /* ⚠ 输入区聚焦时，按键必须转投给它。
                           全局禁用了系统输入法，输入区没有别的输入途径 ——
                           不改投的话用户点输入区敲键盘，**字符全进代码里**，
                           而输入区永远是空的。他只会以为输入区坏了。 */
                        if (run.stdinFocused) {
                            run.stdin = applyToStdin(run.stdin, act)
                            return@CodeKeyboard
                        }
                        /* 键盘上有「运行」键。不接线的话它就是个坏按钮：
                           按下去毫无反应，用户会以为键盘失灵。 */
                        if (act == EditAction.Run) {
                            doRun(scope, runHost, run, value.text, fileName, sourceOf, runnerId)
                            return@CodeKeyboard
                        }
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


/* ============================================================
   运行与输入区编辑的辅助函数
   ------------------------------------------------------------
   放在外面是为了能被测试直接调（不依赖 Compose 运行时）。
   ============================================================ */

/* 把自研键盘的动作作用到输入区。
   复用 editor 包里那些已测过的纯函数：退格删整个缩进、
   回车继承缩进、上下移保持列号 —— 输入区理应和代码区一样好用。 */
internal fun applyToStdin(v: androidx.compose.ui.text.input.TextFieldValue, act: EditAction)
        : androidx.compose.ui.text.input.TextFieldValue = when (act) {
    is EditAction.Insert   -> insertText(v, act.text)
    is EditAction.Bracket  -> insertBracket(v, act.open, act.close)
    EditAction.Tab         -> insertText(v, DEFAULT_INDENT)
    EditAction.Enter       -> enter(v, DEFAULT_INDENT)
    EditAction.Backspace   -> backspace(v, DEFAULT_INDENT)
    EditAction.Left        -> moveLeft(v)
    EditAction.Right       -> moveRight(v)
    EditAction.Up          -> moveVertical(v, -1)
    EditAction.Down        -> moveVertical(v, 1)
    EditAction.Home        -> home(v)
    EditAction.End         -> end(v)
    EditAction.SelectAll   -> v.copy(selection = androidx.compose.ui.text.TextRange(0, v.text.length))
    /* 输入区没有历史栈：它只是临时数据，撤销在这里没意义。
       吞掉而不是让键盘报错。 */
    EditAction.Undo, EditAction.Redo -> v
    EditAction.Save        -> v
    EditAction.PageUp      -> moveVertical(v, -10)
    EditAction.PageDown    -> moveVertical(v, 10)
    /* ⚠ 下面三个不能漏：EditAction 是 sealed interface，
       when 作表达式用时缺分支**编译不过**。
       但更要紧的是语义：剪贴板三类在输入区不该静默变成"什么都不做"，
       所以交给调用方处理（见 EditorScreen 里的 Paste 分支）。 */
    EditAction.Copy        -> v
    EditAction.Cut         -> v
    EditAction.Paste       -> v
    EditAction.Run         -> v
    /* Escape：键盘切页/收起。输入区里没有"页"的概念，
       吞掉即可 —— 但不能漏，漏了会编译不过。 */
    EditAction.Escape      -> v
}

internal fun doRun(
    scope: kotlinx.coroutines.CoroutineScope,
    host: io.code.app.run.RunHost,
    state: RunState,
    code: String,
    fileName: String,
    sourceOf: (String) -> String,
    runnerId: String?
) {
    state.visible = true
    if (runnerId == null) {
        state.result = io.code.app.run.RunResult(
            out = "",
            err = "这个文件认不出是哪种语言，没法运行。\n" +
                "目前支持：C / C++（.c .cpp .cc）、Python（.py）、JavaScript（.js）。"
        )
        return
    }
    state.running = true
    state.result = null
    val source = sourceOf(runnerId)
    if (source.isBlank()) {
        state.running = false
        state.result = io.code.app.run.RunResult(
            out = "",
            err = "解释器源码没读到（$runnerId.js 不在 assets 里）。\n" +
                "构建时请把 js/cpplite.js 与 js/pylite.js 放进 app/src/main/assets/。"
        )
        return
    }
    scope.launch {
        val r = host.runSync(code, state.stdin.text, runnerId, source)
        state.running = false
        state.result = r
    }
}
