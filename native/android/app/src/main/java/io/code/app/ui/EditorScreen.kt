package io.code.app.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Save
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalTextInputService
import androidx.compose.ui.text.font.FontFamily
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
fun EditorScreen(fileName: String, store: io.code.app.data.FileStore) {
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current

    var value by remember {
        mutableStateOf(TextFieldValue(store.read(fileName)))
    }
    var saveState by remember { mutableStateOf<SaveState>(SaveState.Idle) }
    var lastSaved by remember { mutableStateOf(store.read(fileName)) }

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
                        value = when (act) {
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
                                    } catch (e: IOException) {
                                        saveState = SaveState.Failed(e.message ?: "写入失败")
                                    }
                                }
                                value
                            }
                            else -> value   // 复制/粘贴/撤销/运行：第三阶段接
                        }
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
                onValueChange = { value = it },
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
