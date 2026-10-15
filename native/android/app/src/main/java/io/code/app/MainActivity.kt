package io.code.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.tooling.preview.Preview
import io.code.app.data.FileStore
import io.code.app.ui.EditorScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            CodeApp {
                EditorScreen(fileName = "main.cpp", store = FileStore(this))
            }
        }
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
