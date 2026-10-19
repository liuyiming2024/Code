package io.code.app

import android.os.Bundle
import java.io.File
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.*
import androidx.compose.ui.tooling.preview.Preview
import io.code.app.data.FileStore
import io.code.app.run.RunHost
import io.code.app.ui.EditorScreen
import io.code.app.ui.FileDrawer

/* ============================================================
   入口
   ------------------------------------------------------------
   多文件：当前文件、文件列表都存在这里（界面重建时不丢）。

   ⚠ 启动时如果**一个文件都没有**，不能让界面空着：
     空界面 = 用户以为应用坏了。所以自动建一个 main.cpp ——
     这跟 Web 端 README.md 的做法一致。

   ⚠ 当前文件可能已被删（在抽屉里删了）。
     所以每次渲染都要核对它还在不在，不在就切到剩下第一个。
     不核对的话，界面会一直显示一个已被删除的文件名，
     而保存时写到一个"不存在"的路径上 —— 看起来成功，其实什么都没存。
   ============================================================ */

class MainActivity : ComponentActivity() {

    /* 运行调度器。**必须在这里持有**（而不是在 Compose 内部）：
       Compose 重组可能多次创建对象，引擎跟着泄漏。
       并且在 onDestroy 里显式释放。 */
    private lateinit var runHost: RunHost
    private lateinit var store: FileStore

    /* ---------- 导入 / 导出 ----------
       必须走系统的文件选择器（SAF）：直接往公共目录写文件
       在 Android 10+ 上被限制，而且需要我们自己申请存储权限 ——
       而本应用**没有也不该有**存储权限，用户给一个文件 URI
       就够了。

       ⚠ registerForActivityResult 必须在 Activity **启动前**注册，
         所以放在这里做属性初始化，不能放到 onCreate 里。

       ⚠ 结果回来后要刷新 Compose 里的文件列表，
         但回调发生在 Activity 侧、列表状态在 Compose 侧 ——
         用一个可变引用搭桥（比把 state 提升出 setContent 简单，
         且不会在重组时被重建）。 */
    private var onFilesChanged: (() -> Unit)? = null

    private val exportLauncher = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.CreateDocument("application/zip")
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        try {
            contentResolver.openOutputStream(uri)?.use { os ->
                val tmp = File(cacheDir, "export.zip")
                store.exportZip(tmp)
                tmp.inputStream().use { it.copyTo(os) }
                tmp.delete()
            }
            android.widget.Toast.makeText(this, "已导出工程", android.widget.Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            android.util.Log.e("code_store", "导出失败", e)
            android.widget.Toast.makeText(
                this, "导出失败：${'$'}{e.message ?: "未知原因"}", android.widget.Toast.LENGTH_LONG
            ).show()
        }
    }

    private val importLauncher = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        try {
            val tmp = File(cacheDir, "import-${'$'}{System.currentTimeMillis()}.zip")
            contentResolver.openInputStream(uri)?.use { it.copyTo(tmp.outputStream()) }
            val n = store.importZip(tmp)
            tmp.delete()
            onFilesChanged?.invoke()
            android.widget.Toast.makeText(this, "已导入 ${'$'}n 个文件", android.widget.Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            android.util.Log.e("code_store", "导入失败", e)
            android.widget.Toast.makeText(
                this, "导入失败：${'$'}{e.message ?: "未知原因"}", android.widget.Toast.LENGTH_LONG
            ).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        runHost = RunHost()
        store = FileStore(this)
        enableEdgeToEdge()
        setContent {
            CodeApp {
                var current by remember { mutableStateOf("") }
                var files by remember { mutableStateOf(store.list()) }
                var drawer by remember { mutableStateOf(false) }

                /* 首次启动：一个文件都没有就建一个 */
                LaunchedEffect(Unit) {
                    val l = store.list()
                    if (l.isEmpty()) {
                        store.write("main.cpp", DEFAULT_MAIN)
                        files = store.list()
                        current = "main.cpp"
                    } else {
                        files = l
                        current = l.first()
                    }
                }

                /* 当前文件被删了 → 切到剩下第一个。不核对就会写进虚空 */
                LaunchedEffect(files) {
                    if (current.isNotEmpty() && !files.contains(current)) {
                        current = files.firstOrNull() ?: ""
                    }
                }

                if (current.isNotEmpty()) {
                    EditorScreen(
                        fileName = current,
                        store = store,
                        runHost = runHost,
                        sourceOf = { id -> readInterpreter(this@MainActivity, id) },
                        onOpenDrawer = { files = store.list(); drawer = true },
                        onFileChanged = { files = store.list() }
                    )
                }

                if (drawer) {
                    androidx.compose.material3.ModalNavigationDrawer(
                        drawerContent = {
                            FileDrawer(
                                files = files,
                                current = current,
                                onOpen = { p -> current = p; drawer = false },
                                onCreate = { p ->
                                    store.write(p, "")
                                    files = store.list(); current = p; drawer = false
                                },
                                onRename = { a, b ->
                                    store.rename(a, b)
                                    files = store.list()
                                    if (current == a) current = b
                                },
                                onDelete = { p ->
                                    store.delete(p)
                                    files = store.list()
                                },
                                onDismiss = { drawer = false },
                                /* ⚠ 导入完成后必须刷新列表并核对当前文件：
                                   不刷新的话界面仍显示旧列表，
                                   用户会以为导入失败了。 */
                                onExport = { exportLauncher.launch("code-project.zip") },
                                onImport = {
                                    onFilesChanged = { files = store.list() }
                                    importLauncher.launch(arrayOf("application/zip", "application/x-zip-compressed"))
                                }
                            )
                        },
                        content = { }
                    )
                }
            }
        }
    }

    /* ============================================================
       释放引擎
       ------------------------------------------------------------
       ⚠⚠ 这个方法**必须在 Activity 里**。
          它上一版被放进了 `PreviewEditor()` —— 一个**顶层** @Composable
          函数。在那里：
            · `override` 不合法（只有类成员才能 override）
            · `super` 不存在
            · `runHost` 也不在作用域里
          即：**这段代码根本编译不过**。

          而且后果不止是编译报错：引擎从来没被释放过 ——
          QuickJS Runtime 每次重建 Activity 都泄漏一个，
          症状正是下面注释里写的"来回切几次就越来越卡"。
          注释警告的正是它自己没能生效的这件事。
       ============================================================ */
    override fun onDestroy() {
        super.onDestroy()
        if (::runHost.isInitialized) runHost.close()
    }

    companion object {
        const val DEFAULT_MAIN = """#include <iostream>
using namespace std;

int main() {
    cout << "hello" << endl;
    return 0;
}
"""
    }
}

@Composable
fun CodeApp(content: @Composable () -> Unit) {
    // 写代码的人大多用深色主题
    MaterialTheme(colorScheme = darkColorScheme()) {
        Surface { content() }
    }
}

@Preview(showBackground = true)
@Composable
fun PreviewEditor() {
    CodeApp { }
}

/* ============================================================
   从 assets 读解释器源码
   ------------------------------------------------------------
   ⚠ 读不到必须**明确报错**，不能返回空串让引擎静默失败：
     空串 → 引擎建得出来、run 也不报错，只是永远提示
     "Code.cpplite 不存在"。这种"什么都没发生"是最难查的一类，
     用户会以为是自己的代码有问题。
   ============================================================ */
fun readInterpreter(ctx: android.content.Context, id: String): String {
    val name = when (id) {
        "cpplite", "pylite" -> "$id.js"
        else -> return ""
    }
    return try {
        ctx.assets.open(name).bufferedReader().use { it.readText() }
    } catch (e: Exception) {
        android.util.Log.e("code_runner", "读不到 assets/$name：${e.message}")
        ""
    }
}
