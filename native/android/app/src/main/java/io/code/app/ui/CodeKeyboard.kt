package io.code.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.haptic.HapticFeedbackType
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.rememberHapticFeedback
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.isActive

/* ============================================================
   代码编辑器专用键盘（原生 Compose）
   ------------------------------------------------------------
   为什么这一块最该做成原生：

   1. 系统输入法根本不适合写代码 —— 没有 Tab、没有方向键、
      没有括号补全，还会自作主张地纠错和联想。
   2. Web 端只能"绕过"它（vkeyboard.js 553 行做的就是这个），
      而原生可以从源头解决：**根本不让它弹出来**。
   3. 手感是 Web 给不了的：触觉反馈、精确的按下状态、
      长按重复的节奏控制。

   这不是把 vkeyboard.js 翻译一遍 —— DOM 那套逻辑在这里没用。
   键位沿用（用户已经熟悉），实现全部重写。
   ============================================================ */

/** 键盘对编辑器的所有操作。密封接口：新增动作时编译器会提醒你补全。 */
sealed interface EditAction {
    data class Insert(val text: String) : EditAction
    data object Tab : EditAction
    data object Enter : EditAction
    data object Backspace : EditAction
    data object Left : EditAction
    data object Right : EditAction
    data object Up : EditAction
    data object Down : EditAction
    data object Home : EditAction
    data object End : EditAction
    data object PageUp : EditAction
    data object PageDown : EditAction
    data object SelectAll : EditAction
    data object Copy : EditAction
    data object Cut : EditAction
    data object Paste : EditAction
    data object Undo : EditAction
    data object Redo : EditAction
    data object Save : EditAction
    data object Run : EditAction
    data class Bracket(val open: String, val close: String) : EditAction
    data object Escape : EditAction
}

/** 单键定义。 */
private data class Key(
    val label: String,
    val action: EditAction,
    val weight: Float = 1f,
    val repeatable: Boolean = false,   // 长按是否连发
    val isMod: Boolean = false,        // 修饰键样式（灰底）
)

/** 当前页 */
private enum class Page { ABC, SYM, FN }

/* ---------------- 键位表（沿用 Web 版，用户已熟悉） ---------------- */

private val ABC_ROWS = listOf(
    listOf("q","w","e","r","t","y","u","i","o","p"),
    listOf("a","s","d","f","g","h","j","k","l"),
    listOf("z","x","c","v","b","n","m")
)

private val SYM_ROWS = listOf(
    listOf("1","2","3","4","5","6","7","8","9","0"),
    listOf("(", ")", "[", "]", "{", "}", ",", "."),
    listOf("<", ">", "=", "+", "-", "*", "/", "%", "!", "?", "|", "^"),
    listOf("&", "#", "~", "`", "\\", "\"", "'", ";", ":")
)

/** 成对符号：输入开括号自动补闭括号，光标停在中间。 */
private val PAIRS = mapOf(
    "(" to ")", "[" to "]", "{" to "}", "<" to ">",
    "\"" to "\"", "'" to "'", "`" to "`"
)

@Composable
fun CodeKeyboard(
    onAction: (EditAction) -> Unit,
    modifier: Modifier = Modifier,
    indentUnit: String = "    ",   // Tab 插入什么（默认 4 空格，竞赛常用）
) {
    var page by remember { mutableStateOf(Page.ABC) }
    var shift by remember { mutableStateOf(false) }
    var shiftLock by remember { mutableStateOf(false) }

    // 大写/小写：shift 或 shiftLock 任一为真
    val upper = shift || shiftLock

    Surface(
        modifier = modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        tonalElevation = 3.dp
    ) {
        Column(Modifier.padding(horizontal = 3.dp, vertical = 5.dp)) {

            when (page) {
                Page.ABC -> {
                    ABC_ROWS.forEachIndexed { idx, row ->
                        Row(Modifier.fillMaxWidth()) {
                            if (idx == 1) Spacer(Modifier.weight(0.25f))
                            if (idx == 2) {
                                // 第三行左侧放 Shift
                                ModKey(
                                    label = if (shiftLock) "⇩" else "⇧",
                                    weight = 1.25f,
                                    active = shift || shiftLock,
                                    onTap = {
                                        // 单击切换，双击锁定。
                                        // 锁定是写代码的实际需求（打全大写常量名）
                                        if (shift && !shiftLock) {
                                            shiftLock = true; shift = false
                                        } else {
                                            shift = !shift; shiftLock = false
                                        }
                                    },
                                    onLongPress = { shiftLock = true; shift = false }
                                )
                                Spacer(Modifier.weight(0.1f))
                            }
                            row.forEach { ch ->
                                val text = if (upper) ch.uppercase() else ch
                                LetterKey(text) { onAction(EditAction.Insert(text)) }
                            }
                            if (idx == 2) {
                                Spacer(Modifier.weight(0.1f))
                                ModKey("⌫", weight = 1.25f, repeatable = true) {
                                    onAction(EditAction.Backspace)
                                }
                            }
                        }
                    }
                    // 底行
                    Row(Modifier.fillMaxWidth()) {
                        ModKey("符", weight = 1.3f) { page = Page.SYM }
                        ModKey("Tab", weight = 1.5f) { onAction(EditAction.Tab) }
                        // Tab 长按插入缩进单位 —— 与 Web 版行为一致
                        LetterKey("空格", weight = 1.8f) { onAction(EditAction.Insert(" ")) }
                        ModKey("↵", weight = 1.2f) { onAction(EditAction.Enter) }
                    }
                }

                Page.SYM -> {
                    SYM_ROWS.forEach { row ->
                        Row(Modifier.fillMaxWidth()) {
                            row.forEach { ch ->
                                val close = PAIRS[ch]
                                LetterKey(ch) {
                                    if (close != null) onAction(EditAction.Bracket(ch, close))
                                    else onAction(EditAction.Insert(ch))
                                }
                            }
                        }
                    }
                    Row(Modifier.fillMaxWidth()) {
                        ModKey("abc", weight = 1.3f) { page = Page.ABC }
                        ModKey("Tab", weight = 1.5f) { onAction(EditAction.Tab) }
                        LetterKey("空格", weight = 1.8f) { onAction(EditAction.Insert(" ")) }
                        ModKey("⌫", weight = 1.2f, repeatable = true) {
                            onAction(EditAction.Backspace)
                        }
                    }
                }

                Page.FN -> {
                    Row(Modifier.fillMaxWidth()) {
                        NavKey("←", EditAction.Left, repeatable = true, onAction = onAction)
                        NavKey("→", EditAction.Right, repeatable = true, onAction = onAction)
                        NavKey("↑", EditAction.Up, repeatable = true, onAction = onAction)
                        NavKey("↓", EditAction.Down, repeatable = true, onAction = onAction)
                    }
                    Row(Modifier.fillMaxWidth()) {
                        ModKey("Home") { onAction(EditAction.Home) }
                        ModKey("End") { onAction(EditAction.End) }
                        ModKey("PgUp") { onAction(EditAction.PageUp) }
                        ModKey("PgDn") { onAction(EditAction.PageDown) }
                    }
                    Row(Modifier.fillMaxWidth()) {
                        ModKey("全选") { onAction(EditAction.SelectAll) }
                        ModKey("复制") { onAction(EditAction.Copy) }
                        ModKey("剪切") { onAction(EditAction.Cut) }
                        ModKey("粘贴") { onAction(EditAction.Paste) }
                    }
                    Row(Modifier.fillMaxWidth()) {
                        ModKey("撤销") { onAction(EditAction.Undo) }
                        ModKey("重做") { onAction(EditAction.Redo) }
                        ModKey("保存") { onAction(EditAction.Save) }
                        ModKey("运行") { onAction(EditAction.Run) }
                    }
                    Row(Modifier.fillMaxWidth()) {
                        ModKey("abc") { page = Page.ABC }
                        ModKey("Esc") { onAction(EditAction.Escape) }
                        ModKey("⌫", repeatable = true) { onAction(EditAction.Backspace) }
                    }
                }
            }

            // 页切换条常驻
            Row(
                Modifier.fillMaxWidth().padding(top = 3.dp),
                horizontalArrangement = Arrangement.Center
            ) {
                PageChip("abc", page == Page.ABC) { page = Page.ABC }
                Spacer(Modifier.width(6.dp))
                PageChip("符号", page == Page.SYM) { page = Page.SYM }
                Spacer(Modifier.width(6.dp))
                PageChip("功能", page == Page.FN) { page = Page.FN }
            }
        }
    }
}

@Composable
private fun RowScope.LetterKey(
    label: String,
    weight: Float = 1f,
    onClick: () -> Unit
) {
    KeyButton(
        label = label,
        weight = weight,
        repeatable = false,
        isMod = false,
        onClick = onClick
    )
}

@Composable
private fun RowScope.NavKey(
    label: String,
    action: EditAction,
    repeatable: Boolean,
    onAction: (EditAction) -> Unit
) {
    KeyButton(label, isMod = true, repeatable = repeatable) { onAction(action) }
}

@Composable
private fun RowScope.ModKey(
    label: String,
    weight: Float = 1f,
    repeatable: Boolean = false,
    active: Boolean = false,
    onTap: () -> Unit = {},
    onLongPress: () -> Unit = {}
) {
    KeyButton(
        label = label,
        weight = weight,
        repeatable = repeatable,
        isMod = true,
        active = active,
        onTap = onTap,
        onLongPress = onLongPress
    )
}

@Composable
private fun PageChip(label: String, active: Boolean, onClick: () -> Unit) {
    val bg = if (active) MaterialTheme.colorScheme.primary
             else MaterialTheme.colorScheme.surfaceContainerHighest
    val fg = if (active) MaterialTheme.colorScheme.onPrimary
             else MaterialTheme.colorScheme.onSurface
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(50),
        color = bg,
        modifier = Modifier.padding(vertical = 2.dp)
    ) {
        Text(
            label,
            color = fg,
            fontSize = 12.sp,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
        )
    }
}

/**
 * 单个按键。
 *
 * 手感三件事，都是 Web 版做不到或做不好的：
 *   ① 按下状态（视觉）—— 精确到 pointer 按下/抬起，不是 :active 伪类
 *   ② 触觉反馈 —— 原生才有
 *   ③ 长按重复 —— 按住 400ms 后开始，每 45ms 一次
 *
 * ⚠ 长按重复的实现有一个坑，第一版我写错了：
 *     如果把 delay(400) 直接写在 onPress 里，它会**阻塞** tryAwaitRelease，
 *     于是单击也要等满 400ms 才有反应 —— 每按一次退格都慢半拍。
 *     更糟的是：抬起时那个 while 循环可能还没被取消，
 *     于是"按一下退格"变成"400ms 后开始连删一串"。
 *
 *   正确做法：把重复放进**独立的子协程**，pointer 一抬起就 cancel 掉它。
 *   这样单击即时响应（走 onTap），长按才进入连发。
 */
@Composable
private fun RowScope.KeyButton(
    label: String,
    weight: Float = 1f,
    repeatable: Boolean = false,
    isMod: Boolean = false,
    active: Boolean = false,
    onTap: () -> Unit = {},
    onLongPress: (() -> Unit)? = null   // null 表示没有长按动作
) {
    var pressed by remember { mutableStateOf(false) }
    val haptic: HapticFeedback = rememberHapticFeedback()

    val bg = when {
        pressed || active -> MaterialTheme.colorScheme.primaryContainer
        isMod -> MaterialTheme.colorScheme.surfaceContainerHighest
        else -> MaterialTheme.colorScheme.surfaceContainerLow
    }
    val fg = if (pressed || active) MaterialTheme.colorScheme.onPrimaryContainer
             else MaterialTheme.colorScheme.onSurface

    Surface(
        modifier = Modifier
            .weight(weight)
            .padding(2.dp)
            .pointerInput(label, repeatable) {
                detectTapGestures(
                    onPress = {
                        pressed = true
                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)

                        // 重复的连发放在独立子协程里，不阻塞下面的等待
                        val repeater = if (repeatable) {
                            launch {
                                delay(400)                 // 按住 400ms 才开始连发
                                while (isActive) {
                                    onTap()
                                    delay(45)
                                }
                            }
                        } else null

                        try {
                            tryAwaitRelease()              // 单击/长按都在这里等待
                        } finally {
                            repeater?.cancel()             // 一抬起就停，不会多删
                            pressed = false
                        }
                    },
                    onTap = {
                        // 单击：即时响应，不等那 400ms
                        haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                        onTap()
                    },
                    onLongPress = {
                        if (!repeatable && onLongPress != null) {
                            haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                            onLongPress.invoke()
                        }
                    }
                )
            },
        shape = RoundedCornerShape(6.dp),
        color = bg,
        tonalElevation = if (pressed) 6.dp else 1.dp
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .defaultMinSize(minHeight = 44.dp)
                .padding(horizontal = 2.dp)
        ) {
            Text(
                label,
                color = fg,
                fontSize = 17.sp,
                fontFamily = FontFamily.Monospace,
                textAlign = TextAlign.Center,
                maxLines = 1
            )
        }
    }
}

