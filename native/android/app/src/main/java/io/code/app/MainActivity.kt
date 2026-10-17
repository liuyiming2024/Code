package io.code.app

import android.os.Bundle
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        runHost = RunHost()
        enableEdgeToEdge()
        setContent {
            CodeApp {
                val store = remember { FileStore(this) }
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
                                onDismiss = { drawer = false }
                            )
                        },
                        content = { }
                    )
                }
            }
        }
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

    /* 释放引擎。不调的话 QuickJS Runtime 一直占着内存，
       症状是"来回切几次就越来越卡"，很难联想到这里。 */
    override fun onDestroy() {
        super.onDestroy()
        if (::runHost.isInitialized) runHost.close()
    }
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
