package dev.zxlab.zxtoolkit

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import coil.compose.AsyncImage
import dev.zxlab.zxtoolkit.data.InboxEntity
import dev.zxlab.zxtoolkit.model.DropPayload
import dev.zxlab.zxtoolkit.ui.PairingScanner
import kotlinx.serialization.json.Json
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val Paper = Color(0xFFF4F1EA)
private val Ink = Color(0xFF17231F)
private val Moss = Color(0xFF1E5B46)
private val Coral = Color(0xFFE35D3F)

@Composable
fun ZxToolkitUi(viewModel: MainViewModel) {
    val state by viewModel.state.collectAsState()
    val inbox by viewModel.inbox.collectAsState()
    val context = LocalContext.current
    MaterialTheme(colorScheme = lightColorScheme(primary = Moss, secondary = Coral, background = Paper, surface = Color(0xFFFCFAF5), onBackground = Ink)) {
        Surface(Modifier.fillMaxSize(), color = Paper) {
            when {
                state.loading -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                !state.paired -> PairingPage(state, viewModel)
                else -> MainShell(state, inbox, viewModel)
            }
            state.preview?.let { (file, mime) ->
                AlertDialog(
                    onDismissRequest = viewModel::closePreview,
                    title = { Text(file.name) },
                    text = { if (mime.startsWith("image/")) AsyncImage(file, file.name, Modifier.fillMaxWidth()) else Text("文件已下载，可从收件箱分享或保存。") },
                    confirmButton = { TextButton(onClick = viewModel::closePreview) { Text("关闭") } },
                )
            }
        }
    }
    LaunchedEffect(state.message) {
        if (state.message != null) {
            kotlinx.coroutines.delay(3_000)
            viewModel.clearMessage()
        }
    }
}

@Composable
private fun PairingPage(state: MainUiState, viewModel: MainViewModel) {
    Column(Modifier.fillMaxSize().padding(horizontal = 24.dp, vertical = 32.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(38.dp).background(Moss, RoundedCornerShape(6.dp)), contentAlignment = Alignment.Center) { Text("zx", color = Color.White, fontWeight = FontWeight.Bold) }
            Spacer(Modifier.width(12.dp)); Text("zxtoolkit", style = MaterialTheme.typography.titleLarge)
        }
        if (state.pairingId == null) PairingScanner(viewModel::inspectPairing) else {
            Column(Modifier.fillMaxWidth().background(Color(0xFFFCFAF5)).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("确认连接", style = MaterialTheme.typography.titleLarge)
                InfoRow("Mac", state.pairingMacName ?: "未知设备")
                InfoRow("这台设备", state.deviceName)
                Button(viewModel::confirmPairing, Modifier.fillMaxWidth()) { Text("确认配对") }
                TextButton(viewModel::cancelPairingConfirmation, Modifier.fillMaxWidth()) { Text("重新扫描") }
            }
        }
        Text("本机名称：${state.deviceName}", style = MaterialTheme.typography.bodySmall)
        MessageLine(state.message)
    }
}

@Composable
private fun MainShell(state: MainUiState, inbox: List<InboxEntity>, viewModel: MainViewModel) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    Scaffold(
        containerColor = Paper,
        topBar = {
            Row(Modifier.fillMaxWidth().padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("zx", color = Color.White, modifier = Modifier.background(Moss, RoundedCornerShape(5.dp)).padding(horizontal = 9.dp, vertical = 6.dp), fontWeight = FontWeight.Bold)
                Spacer(Modifier.width(10.dp)); Column(Modifier.weight(1f)) { Text("zxtoolkit", fontWeight = FontWeight.SemiBold); Text(state.mac?.name ?: "等待 Mac", style = MaterialTheme.typography.labelSmall) }
                Text(state.socketState, style = MaterialTheme.typography.labelMedium, color = Moss)
            }
        },
        bottomBar = {
            NavigationBar(containerColor = Color(0xFFFCFAF5)) {
                NavigationBarItem(tab == 0, { tab = 0 }, { Icon(Icons.Outlined.Inbox, null) }, label = { Text("收件") })
                NavigationBarItem(tab == 1, { tab = 1 }, { Icon(Icons.Outlined.Send, null) }, label = { Text("发送") })
                NavigationBarItem(tab == 2, { tab = 2 }, { Icon(Icons.Outlined.Devices, null) }, label = { Text("设备") })
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (tab) {
                0 -> InboxPage(inbox, viewModel)
                1 -> SendPage(viewModel)
                else -> SettingsPage(state, viewModel)
            }
            MessageLine(state.message, Modifier.align(Alignment.BottomCenter).padding(16.dp))
        }
    }
}

@Composable
private fun InboxPage(inbox: List<InboxEntity>, viewModel: MainViewModel) {
    val context = LocalContext.current
    var saving by remember { mutableStateOf<InboxEntity?>(null) }
    val save = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val item = saving; saving = null
        if (uri != null && item != null) viewModel.save(item, uri)
    }
    if (inbox.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) { Icon(Icons.Outlined.MoveToInbox, null, Modifier.size(42.dp), tint = Moss); Spacer(Modifier.height(12.dp)); Text("收件箱是空的"); Text("从 Mac 投递的内容会出现在这里", style = MaterialTheme.typography.bodySmall) }
        }
        return
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(1.dp)) {
        items(inbox, key = { it.id }) { item ->
            InboxRow(item,
                onOpen = {
                    viewModel.claimText(item) { payload ->
                        when (payload) {
                            is DropPayload.Text -> context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("zxtoolkit", payload.text))
                            is DropPayload.Url -> context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(payload.url)))
                            else -> Unit
                        }
                    }
                },
                onPreview = { viewModel.previewOrShare(item, false) },
                onShare = { viewModel.previewOrShare(item, true) { context.startActivity(Intent.createChooser(it, "分享文件")) } },
                onSave = { saving = item; save.launch(payloadName(item)) },
            )
        }
    }
}

@Composable
private fun InboxRow(item: InboxEntity, onOpen: () -> Unit, onPreview: () -> Unit, onShare: () -> Unit, onSave: () -> Unit) {
    val payload = remember(item.payloadJson) { Json { ignoreUnknownKeys = true; classDiscriminator = "type" }.decodeFromString<DropPayload>(item.payloadJson) }
    val binary = payload is DropPayload.Image || payload is DropPayload.File
    Row(Modifier.fillMaxWidth().background(Color(0xFFFCFAF5)).padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(if (binary) Icons.Outlined.Description else if (payload is DropPayload.Url) Icons.Outlined.Link else Icons.Outlined.TextSnippet, null, tint = Moss)
        Spacer(Modifier.width(14.dp))
        Column(Modifier.weight(1f)) {
            Text(payloadSummary(payload), maxLines = 2, overflow = TextOverflow.Ellipsis)
            Text("${item.senderName} · ${formatTime(item.createdAt)} · ${statusLabel(item.status)}", style = MaterialTheme.typography.labelSmall)
        }
        if (binary) {
            IconButton(onClick = onPreview) { Icon(Icons.Outlined.Visibility, "预览") }
            IconButton(onClick = onShare) { Icon(Icons.Outlined.Share, "分享") }
            IconButton(onClick = onSave) { Icon(Icons.Outlined.SaveAlt, "保存") }
        } else IconButton(onClick = onOpen) { Icon(if (payload is DropPayload.Url) Icons.Outlined.OpenInNew else Icons.Outlined.ContentCopy, "打开") }
    }
}

@Composable
private fun SendPage(viewModel: MainViewModel) {
    var text by rememberSaveable { mutableStateOf("") }
    val context = LocalContext.current
    val photo = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { it?.let(viewModel::sendUri) }
    val document = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { it?.let(viewModel::sendUri) }
    var cameraFile by remember { mutableStateOf<File?>(null) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok -> if (ok) cameraFile?.let { viewModel.sendUri(FileProvider.getUriForFile(context, "${context.packageName}.files", it)) } }
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Text("发送到 Mac", style = MaterialTheme.typography.headlineSmall)
        OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth().heightIn(min = 150.dp), label = { Text("文字或链接") }, maxLines = 8)
        Button(onClick = { viewModel.sendText(text); text = "" }, enabled = text.isNotBlank(), modifier = Modifier.fillMaxWidth()) { Icon(Icons.Outlined.Send, null); Spacer(Modifier.width(8.dp)); Text("发送") }
        HorizontalDivider()
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
            SendTool(Icons.Outlined.Photo, "照片") { photo.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
            SendTool(Icons.Outlined.PhotoCamera, "相机") {
                val file = File(context.cacheDir, "outgoing/camera-${System.currentTimeMillis()}.jpg").also { it.parentFile?.mkdirs() }
                cameraFile = file
                camera.launch(FileProvider.getUriForFile(context, "${context.packageName}.files", file))
            }
            SendTool(Icons.Outlined.AttachFile, "文件") { document.launch(arrayOf("*/*")) }
        }
        Text("单个文件最大 20 MiB", style = MaterialTheme.typography.bodySmall)
    }
}

@Composable private fun SendTool(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, action: () -> Unit) {
    Column(Modifier.clickable(onClick = action).padding(12.dp), horizontalAlignment = Alignment.CenterHorizontally) { Icon(icon, label, tint = Moss); Spacer(Modifier.height(6.dp)); Text(label) }
}

@Composable
private fun SettingsPage(state: MainUiState, viewModel: MainViewModel) {
    var name by remember(state.deviceName) { mutableStateOf(state.deviceName) }
    Column(Modifier.fillMaxSize().padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Text("设备与同步", style = MaterialTheme.typography.headlineSmall)
        InfoRow("绑定 Mac", state.mac?.name ?: "未找到")
        InfoRow("连接", state.socketState)
        InfoRow("后台同步", "联网时约每 15 分钟")
        OutlinedTextField(name, { name = it }, label = { Text("本机名称") }, modifier = Modifier.fillMaxWidth(), trailingIcon = { IconButton(onClick = { viewModel.rename(name) }) { Icon(Icons.Outlined.Check, "保存名称") } })
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) { Text("Pulse"); Text("仅发送在线、电量档位和充电状态", style = MaterialTheme.typography.bodySmall) }
            Switch(state.pulseEnabled, viewModel::setPulse)
        }
        OutlinedButton(viewModel::rotate, Modifier.fillMaxWidth()) { Icon(Icons.Outlined.Autorenew, null); Spacer(Modifier.width(8.dp)); Text("轮换凭证") }
        TextButton(viewModel::unlink, Modifier.fillMaxWidth(), colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Icon(Icons.Outlined.LinkOff, null); Spacer(Modifier.width(8.dp)); Text("解除绑定") }
    }
}

@Composable private fun InfoRow(label: String, value: String) { Row(Modifier.fillMaxWidth()) { Text(label, Modifier.weight(1f)); Text(value, fontWeight = FontWeight.Medium) } }
@Composable private fun MessageLine(message: String?, modifier: Modifier = Modifier) { if (message != null) Text(message, modifier.background(Ink, RoundedCornerShape(4.dp)).padding(horizontal = 14.dp, vertical = 9.dp), color = Color.White) }

private fun payloadSummary(payload: DropPayload) = when (payload) { is DropPayload.Text -> payload.text; is DropPayload.Url -> payload.title ?: payload.url; is DropPayload.Image -> payload.fileName; is DropPayload.File -> payload.fileName }
private fun payloadName(item: InboxEntity) = runCatching { payloadSummary(Json { ignoreUnknownKeys = true; classDiscriminator = "type" }.decodeFromString<DropPayload>(item.payloadJson)) }.getOrDefault("zxtoolkit-file")
private fun statusLabel(status: String) = when (status) { "claimed" -> "已领取"; "opened" -> "已打开"; "expired" -> "已过期"; else -> "未读" }
private fun formatTime(value: String) = runCatching { DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(value)) }.getOrDefault(value)
