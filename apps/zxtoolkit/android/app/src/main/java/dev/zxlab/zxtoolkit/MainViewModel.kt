package dev.zxlab.zxtoolkit

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import dev.zxlab.zxtoolkit.data.InboxEntity
import dev.zxlab.zxtoolkit.data.Repository
import dev.zxlab.zxtoolkit.model.*
import dev.zxlab.zxtoolkit.net.ApiException
import dev.zxlab.zxtoolkit.work.UploadWorker
import dev.zxlab.zxtoolkit.work.publishPulse
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.io.File

data class MainUiState(
    val loading: Boolean = true,
    val paired: Boolean = false,
    val deviceName: String = android.os.Build.MODEL.take(40),
    val mac: Device? = null,
    val socketState: String = "离线",
    val pulseEnabled: Boolean = false,
    val message: String? = null,
    val preview: Pair<File, String>? = null,
    val pairingId: String? = null,
    val pairingMacName: String? = null,
)

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val app = application as ZxToolkitApplication
    private val repository = Repository(app, app.container.api, app.container.database, app.container.credentials)
    private val mutable = MutableStateFlow(MainUiState())
    val state = mutable.asStateFlow()
    val inbox: StateFlow<List<InboxEntity>> = repository.inbox.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), emptyList())
    private var socket: WebSocket? = null
    private var socketJob: Job? = null
    private var heartbeat: Job? = null

    init { viewModelScope.launch { load() } }

    private suspend fun load() {
        val credential = app.container.credentials.credential()
        if (credential == null) {
            mutable.update { it.copy(loading = false, paired = false) }
            return
        }
        mutable.update { it.copy(loading = false, paired = true, deviceName = credential.device.name, pulseEnabled = app.container.credentials.pulseEnabled()) }
        refresh()
        connectSocket()
    }

    fun inspectPairing(pairingId: String) = runTask {
        val preview = app.container.api.pairingPreview(pairingId)
        mutable.update { it.copy(pairingId = pairingId, pairingMacName = preview.desktopName) }
    }

    fun cancelPairingConfirmation() = mutable.update { it.copy(pairingId = null, pairingMacName = null) }

    fun confirmPairing() = runTask {
        val pairingId = mutable.value.pairingId ?: return@runTask
        val credential = app.container.api.confirmPairing(pairingId, mutable.value.deviceName.trim().ifBlank { "Android" })
        app.container.credentials.saveCredential(credential)
        mutable.update { it.copy(paired = true, deviceName = credential.device.name, pairingId = null, pairingMacName = null, message = "配对成功") }
        refresh()
        connectSocket()
    }

    fun refresh() = runTask(showErrors = false) {
        repository.sync()
        val mac = repository.pairedMac()
        mutable.update { it.copy(mac = mac) }
    }

    fun sendText(text: String) = runTask {
        val target = targetId()
        val id = repository.queueText(text, target)
        UploadWorker.enqueue(app, id)
        mutable.update { it.copy(message = "已加入发送队列") }
    }

    fun sendUri(uri: Uri) = runTask {
        val target = targetId()
        val id = repository.queueUri(uri, target)
        UploadWorker.enqueue(app, id)
        mutable.update { it.copy(message = "文件已加入发送队列") }
    }

    fun claimText(item: InboxEntity, onReady: (DropPayload) -> Unit) = runTask {
        val payload = app.container.api.json.decodeFromString<DropPayload>(item.payloadJson)
        repository.markClaimed(item)
        onReady(payload)
    }

    fun previewOrShare(item: InboxEntity, share: Boolean, onShare: (Intent) -> Unit = {}) = runTask {
        val (file, mime) = repository.downloadAndClaim(item.id)
        if (share) onShare(repository.shareFile(file, mime)) else mutable.update { it.copy(preview = file to mime) }
    }

    fun save(item: InboxEntity, destination: Uri) = runTask {
        val (file, _) = repository.downloadAndClaim(item.id)
        app.contentResolver.openOutputStream(destination)?.use { output -> file.inputStream().use { it.copyTo(output) } }
            ?: error("无法写入所选位置")
        mutable.update { it.copy(message = "文件已保存") }
    }

    fun rename(name: String) = runTask {
        val current = app.container.credentials.credential() ?: return@runTask
        val device = app.container.api.rename(current, name.trim())
        app.container.credentials.saveCredential(current.copy(device = device))
        mutable.update { it.copy(deviceName = device.name, message = "名称已更新") }
    }

    fun rotate() = runTask {
        val current = app.container.credentials.credential() ?: return@runTask
        app.container.credentials.saveCredential(app.container.api.rotate(current))
        mutable.update { it.copy(message = "凭证已轮换") }
    }

    fun unlink() = runTask {
        val current = app.container.credentials.credential() ?: return@runTask
        app.container.api.unlink(current, current.device.id)
        app.container.credentials.clear()
        disconnectSocket()
        mutable.value = MainUiState(loading = false, message = "已解除绑定")
    }

    fun setPulse(enabled: Boolean) = runTask {
        app.container.credentials.setPulseEnabled(enabled)
        mutable.update { it.copy(pulseEnabled = enabled) }
        if (enabled) publishPulse(app, "online")
    }

    fun clearMessage() = mutable.update { it.copy(message = null) }
    fun showMessage(message: String) = mutable.update { it.copy(message = message) }
    fun closePreview() = mutable.update { it.copy(preview = null) }

    fun connectSocket() {
        if (!mutable.value.paired || socketJob?.isActive == true) return
        socketJob = viewModelScope.launch {
            var retry = 0
            while (isActive && mutable.value.paired) {
                try {
                    val credential = app.container.credentials.credential() ?: break
                    mutable.update { it.copy(socketState = "连接中") }
                    val ticket = app.container.api.ticket(credential)
                    val closed = CompletableDeferred<Unit>()
                    socket = app.container.api.http.newWebSocket(
                        okhttp3.Request.Builder().url(app.container.api.socketUrl(ticket)).build(),
                        object : WebSocketListener() {
                            override fun onOpen(webSocket: WebSocket, response: Response) {
                                retry = 0
                                mutable.update { it.copy(socketState = "实时在线") }
                                refresh()
                                heartbeat?.cancel()
                                heartbeat = viewModelScope.launch { while (isActive) { delay(25_000); webSocket.send("{\"type\":\"ping\"}") } }
                            }
                            override fun onMessage(webSocket: WebSocket, text: String) { if (text.contains("\"drop_ready\"")) refresh() }
                            override fun onMessage(webSocket: WebSocket, bytes: ByteString) = Unit
                            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
                            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { closed.complete(Unit) }
                            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { closed.complete(Unit) }
                        },
                    )
                    closed.await()
                } catch (error: ApiException) {
                    if (error.status == 401) { app.container.credentials.clear(); mutable.update { it.copy(paired = false) }; break }
                }
                heartbeat?.cancel()
                mutable.update { it.copy(socketState = "重连中") }
                delay((1_000L shl retry.coerceAtMost(5)) + (0..300).random())
                retry++
            }
        }
        runTask(showErrors = false) { refresh(); publishPulse(app, "online") }
    }

    fun disconnectSocket() {
        socketJob?.cancel(); socketJob = null
        heartbeat?.cancel(); heartbeat = null
        socket?.close(1000, "background"); socket = null
        mutable.update { it.copy(socketState = "后台同步") }
    }

    private suspend fun targetId(): String = mutable.value.mac?.id ?: repository.pairedMac()?.id ?: error("没有可用的 Mac")

    private fun runTask(showErrors: Boolean = true, block: suspend () -> Unit) = viewModelScope.launch {
        try { block() } catch (error: Exception) {
            if (showErrors) mutable.update { it.copy(message = error.message ?: "操作失败") }
            if (error is ApiException && error.status == 401) mutable.update { it.copy(paired = false) }
        }
    }

    override fun onCleared() { disconnectSocket() }
}
