package dev.zxlab.zxtoolkit

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Parcelable
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    private val viewModel by viewModels<MainViewModel>()
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent { ZxToolkitUi(viewModel) }
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        viewModel.connectSocket()
        if (Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    override fun onStop() {
        viewModel.disconnectSocket()
        super.onStop()
    }

    private fun handleIntent(value: Intent?) {
        if (value?.action == Intent.ACTION_SEND_MULTIPLE) {
            viewModel.showMessage("首版仅支持单个文件")
            return
        }
        if (value?.action != Intent.ACTION_SEND) return
        lifecycleScope.launch {
            val state = viewModel.state.filter { !it.loading }.first()
            if (!state.paired) {
                viewModel.showMessage("请先与 Mac 配对，再重新分享")
                return@launch
            }
            val stream = if (Build.VERSION.SDK_INT >= 33) value.getParcelableExtra(Intent.EXTRA_STREAM, android.net.Uri::class.java)
                else @Suppress("DEPRECATION") (value.getParcelableExtra<Parcelable>(Intent.EXTRA_STREAM) as? android.net.Uri)
            when {
                stream != null -> viewModel.sendUri(stream)
                !value.getStringExtra(Intent.EXTRA_TEXT).isNullOrBlank() -> viewModel.sendText(value.getStringExtra(Intent.EXTRA_TEXT).orEmpty())
                else -> viewModel.showMessage("分享内容为空")
            }
        }
    }
}
