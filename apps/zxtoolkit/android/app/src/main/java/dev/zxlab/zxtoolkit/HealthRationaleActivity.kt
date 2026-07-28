package dev.zxlab.zxtoolkit

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp

class HealthRationaleActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(Modifier.fillMaxSize(), color = Color(0xFFF3F1EB)) {
                    Column(
                        Modifier.fillMaxSize().background(Color(0xFFF3F1EB)).padding(28.dp),
                        verticalArrangement = Arrangement.spacedBy(18.dp),
                    ) {
                        Text("步数与隐私", style = MaterialTheme.typography.headlineLarge, fontWeight = FontWeight.Medium)
                        Text("zxtoolkit 只读取 Health Connect 中今天的步数，用于在手机首页展示个人摘要。")
                        Text("步数只在这台设备上读取和显示，不会上传到 zxlab、写入 Pulse、用于广告或分享给第三方。你可以随时在 Health Connect 中撤销权限。")
                    }
                }
            }
        }
    }
}
