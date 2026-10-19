package io.code.app.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
/* Share / Download 在 material-icons-extended 里（build.gradle.kts 已引入）。
   少了这两行会直接编译不过 —— 而且报错是 Unresolved reference，
   看不出是依赖缺了还是 import 漏了。 */
import androidx.compose.material.icons.filled.Share
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.code.app.data.PathNorm

/* ============================================================
   文件抽屉：多文件切换 / 新建 / 改名 / 删除
   ------------------------------------------------------------
   全部 Compose。没有 WebView、没有 HTML、没有列表控件套壳。

   ---------- 删除为什么必须二次确认 ----------
   本地文件删了就是没了，没有回收站、没有版本历史。
   一次误触删掉写了半小时的东西，是不可逆的。

   所以点删除先变成"确认删除？"，再点一次才真删。
   ⚠ 这个待确认状态**必须跟着具体条目**，不能只存一个 Boolean ——
     否则点了 A 的删除、又点 B 的删除，B 那个会"直接生效"，
     因为标志位已经被 A 点亮了。表现是"我没确认怎么就删了"。

   ⚠ 切走文件、关掉抽屉时要把待确认清掉，
     否则下次打开抽屉上来就是个亮着的删除按钮。
   ============================================================ */

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FileDrawer(
    files: List<String>,
    current: String,
    onOpen: (String) -> Unit,
    onCreate: (String) -> Unit,
    onRename: (String, String) -> Unit,
    onDelete: (String) -> Unit,
    onDismiss: () -> Unit,
    /* 导入/导出由 Activity 提供（要用到系统的文件选择器）。
       ⚠ 不能在这里直接弹选择器：Composable 里拿不到
          registerForActivityResult 的生命周期宿主。 */
    onExport: () -> Unit = {},
    onImport: () -> Unit = {}
) {
    /* 待确认删除的那一条。存路径而不是 Boolean —— 见上面注释 */
    var pendingDelete by remember { mutableStateOf<String?>(null) }
    var showNew by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf<String?>(null) }

    /* 关抽屉前清干净：下次打开不能带着上次的待确认状态 */
    fun close() { pendingDelete = null; showNew = false; renaming = null; onDismiss() }

    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("文件", fontSize = 16.sp, modifier = Modifier.weight(1f))
            IconButton(onClick = { showNew = true }) {
                Icon(Icons.Default.Add, contentDescription = "新建")
            }
            /* 导出/导入：没有它们，手机上写的代码**搬不出去也搬不进来**。
               FileStore.exportZip 早就写了，但全仓零调用 ——
               写了没接上，等于没有。 */
            IconButton(onClick = { close(); onExport() }) {
                Icon(Icons.Default.Share, contentDescription = "导出工程")
            }
            IconButton(onClick = { close(); onImport() }) {
                Icon(Icons.Default.Download, contentDescription = "导入工程")
            }
            IconButton(onClick = { close() }) {
                Icon(Icons.Default.Close, contentDescription = "关闭")
            }
        }

        if (showNew) {
            NameField(
                label = "新文件路径（可含目录，如 src/main.py）",
                initial = "",
                confirm = "创建",
                onSubmit = { p ->
                    val n = PathNorm.norm(p)
                    if (n == null) return@NameField "路径不合法"
                    if (files.contains(n)) return@NameField "已存在同名文件"
                    onCreate(n); showNew = false; null
                },
                onCancel = { showNew = false }
            )
        }

        renaming?.let { old ->
            NameField(
                label = "改名为",
                initial = old,
                confirm = "改名",
                onSubmit = { p ->
                    val n = PathNorm.norm(p)
                    if (n == null) return@NameField "路径不合法"
                    if (n != old && files.contains(n)) return@NameField "已存在同名文件"
                    onRename(old, n); renaming = null; null
                },
                onCancel = { renaming = null }
            )
        }

        if (files.isEmpty()) {
            Text("还没有文件，点右上角 + 新建一个。", fontSize = 13.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            return@Column
        }

        LazyColumn {
            items(files) { path ->
                val isCur = path == current
                val pending = pendingDelete == path
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clickable { if (!pending) onOpen(path) }
                        .padding(vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        PathNorm.name(path),
                        fontFamily = FontFamily.Monospace,
                        fontSize = 13.sp,
                        color = if (isCur) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier.weight(1f)
                    )
                    /* 目录前缀淡一点显示，否则一长串路径分不清哪个是文件名 */
                    PathNorm.parent(path).let { if (it.isNotEmpty()) {
                        Text(it, fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.width(6.dp))
                    } }

                    if (pending) {
                        TextButton(onClick = { onDelete(path); pendingDelete = null }) {
                            Text("确认删除？", color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
                        }
                        TextButton(onClick = { pendingDelete = null }) {
                            Text("取消", fontSize = 12.sp)
                        }
                    } else {
                        TextButton(onClick = { renaming = path }) {
                            Text("改名", fontSize = 12.sp)
                        }
                        TextButton(onClick = { pendingDelete = path }) {
                            Text("删除", fontSize = 12.sp)
                        }
                    }
                }
            }
        }
    }
}

/* 单行输入。onSubmit 返回错误文案表示拒绝（不关闭），返回 null 表示接受。 */
@Composable
private fun NameField(
    label: String,
    initial: String,
    confirm: String,
    onSubmit: (String) -> String?,
    onCancel: () -> Unit
) {
    var v by remember { mutableStateOf(initial) }
    var err by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
        OutlinedTextField(
            value = v, onValueChange = { v = it; err = null },
            label = { Text(label, fontSize = 12.sp) },
            singleLine = true, isError = err != null,
            modifier = Modifier.fillMaxWidth(),
            textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace, fontSize = 13.sp)
        )
        err?.let { Text(it, color = MaterialTheme.colorScheme.error, fontSize = 11.sp) }
        Row {
            TextButton(onClick = {
                val e = onSubmit(v.trim())
                if (e != null) err = e
            }) { Text(confirm) }
            TextButton(onClick = onCancel) { Text("取消") }
        }
    }
}
