package dev.zxlab.zxtoolkit

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import androidx.health.connect.client.PermissionController
import coil.compose.AsyncImage
import dev.zxlab.zxtoolkit.data.InboxEntity
import dev.zxlab.zxtoolkit.health.HealthAvailability
import dev.zxlab.zxtoolkit.model.BriefingItem
import dev.zxlab.zxtoolkit.model.DailyBriefing
import dev.zxlab.zxtoolkit.model.DropPayload
import dev.zxlab.zxtoolkit.model.normalizeHttpUrl
import dev.zxlab.zxtoolkit.ui.PairingScanner
import kotlinx.serialization.json.Json
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val Paper = Color(0xFFF4F1EA)
private val PaperRaised = Color(0xFFFBF9F4)
private val Ink = Color(0xFF171714)
private val InkMuted = Color(0xFF6E6B63)
private val Moss = Color(0xFF1F5846)
private val MossSoft = Color(0xFFDCE9E2)
private val Acid = Color(0xFFC8E66B)
private val Coral = Color(0xFFD85C43)
private val Line = Color(0xFFD9D5CC)

private val ToolkitTypography = Typography(
    displaySmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 38.sp,
        lineHeight = 40.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = (-1.2).sp,
    ),
    headlineMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 28.sp,
        lineHeight = 31.sp,
        fontWeight = FontWeight.Medium,
        letterSpacing = (-0.6).sp,
    ),
    titleLarge = TextStyle(fontSize = 20.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 16.sp, lineHeight = 21.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
    bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 21.sp),
    bodySmall = TextStyle(fontSize = 12.sp, lineHeight = 17.sp, color = InkMuted),
    labelMedium = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.2.sp),
)

@Composable
fun ZxToolkitUi(viewModel: MainViewModel) {
    val state by viewModel.state.collectAsState()
    val inbox by viewModel.inbox.collectAsState()
    val context = LocalContext.current
    MaterialTheme(
        colorScheme = lightColorScheme(
            primary = Moss,
            onPrimary = Color.White,
            secondary = Coral,
            background = Paper,
            surface = PaperRaised,
            onBackground = Ink,
            onSurface = Ink,
            surfaceVariant = MossSoft,
            outline = Line,
        ),
        typography = ToolkitTypography,
    ) {
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
    Column(
        Modifier.fillMaxSize().padding(horizontal = 22.dp, vertical = 28.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        BrandLockup()
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("让设备之间的距离消失。", style = MaterialTheme.typography.displaySmall, maxLines = 2)
            Text("扫描 Mac 上的配对码。凭证只保存在这台设备上。", color = InkMuted)
        }
        if (state.pairingId == null) {
            Surface(
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(24.dp),
                color = PaperRaised,
                border = androidx.compose.foundation.BorderStroke(1.dp, Line),
            ) {
                Box(Modifier.padding(14.dp)) { PairingScanner(viewModel::inspectPairing) }
            }
        } else {
            Column(
                Modifier.fillMaxWidth().background(PaperRaised, RoundedCornerShape(24.dp)).border(1.dp, Line, RoundedCornerShape(24.dp)).padding(22.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                Text("确认这次连接", style = MaterialTheme.typography.titleLarge)
                InfoRow("Mac", state.pairingMacName ?: "未知设备")
                InfoRow("这台设备", state.deviceName)
                Button(
                    viewModel::confirmPairing,
                    Modifier.fillMaxWidth().heightIn(min = 52.dp),
                    shape = RoundedCornerShape(14.dp),
                ) { Text("确认配对") }
                TextButton(viewModel::cancelPairingConfirmation, Modifier.fillMaxWidth()) { Text("重新扫描") }
            }
        }
        Spacer(Modifier.weight(1f))
        Text("本机名称  ${state.deviceName}", style = MaterialTheme.typography.bodySmall)
        MessageLine(state.message)
    }
}

@Composable
private fun MainShell(state: MainUiState, inbox: List<InboxEntity>, viewModel: MainViewModel) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val healthPermission = rememberLauncherForActivityResult(
        PermissionController.createRequestPermissionResultContract(),
        viewModel::onHealthPermissionResult,
    )
    Scaffold(
        containerColor = Paper,
        topBar = {
            Row(
                Modifier.fillMaxWidth().background(Paper).padding(horizontal = 20.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                BrandMark()
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text("zxtoolkit", fontWeight = FontWeight.SemiBold)
                    Text(state.mac?.name ?: "等待 Mac", style = MaterialTheme.typography.bodySmall)
                }
                ConnectionPill(state.socketState)
            }
        },
        bottomBar = {
            NavigationBar(containerColor = PaperRaised, tonalElevation = 0.dp) {
                NavigationBarItem(tab == 0, { tab = 0 }, { Icon(Icons.Outlined.Today, "今天") }, label = { Text("今天") })
                NavigationBarItem(tab == 1, { tab = 1 }, { Icon(Icons.Outlined.Inbox, "收件") }, label = { Text("收件") })
                NavigationBarItem(tab == 2, { tab = 2 }, { Icon(Icons.Outlined.NorthEast, "发送") }, label = { Text("发送") })
                NavigationBarItem(tab == 3, { tab = 3 }, { Icon(Icons.Outlined.Tune, "设备") }, label = { Text("设备") })
            }
        },
    ) { padding ->
        Box(Modifier.padding(padding).fillMaxSize()) {
            when (tab) {
                0 -> TodayPage(
                    state = state,
                    inboxCount = inbox.count { it.status != "claimed" },
                    onRequestHealth = { healthPermission.launch(viewModel.healthPermissions()) },
                    onRefresh = viewModel::refreshToday,
                    onNavigate = { tab = it },
                )
                1 -> InboxPage(inbox, viewModel)
                2 -> SendPage(viewModel)
                else -> SettingsPage(state, viewModel)
            }
            AnimatedVisibility(
                visible = state.message != null,
                modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
                enter = fadeIn() + slideInVertically { it / 2 },
                exit = fadeOut() + slideOutVertically { it / 2 },
            ) {
                MessageLine(state.message)
            }
        }
    }
}

@Composable
private fun TodayPage(
    state: MainUiState,
    inboxCount: Int,
    onRequestHealth: () -> Unit,
    onRefresh: () -> Unit,
    onNavigate: (Int) -> Unit,
) {
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, top = 14.dp, end = 20.dp, bottom = 34.dp),
        verticalArrangement = Arrangement.spacedBy(22.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("TODAY · ${formatDay()}", style = MaterialTheme.typography.labelMedium, color = InkMuted)
                Text("今天，一眼看清。", style = MaterialTheme.typography.displaySmall, maxLines = 2)
                Text("设备状态、个人步数和 ZX Signal 今日日报集中在这里。", color = InkMuted)
            }
        }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                HealthMetricCard(state, onRequestHealth, onRefresh, Modifier.weight(1f))
                MetricCard(
                    icon = Icons.Outlined.MoveToInbox,
                    title = "待处理",
                    value = inboxCount.toString(),
                    caption = if (inboxCount == 0) "收件箱已清空" else "来自已配对设备",
                    accent = Coral,
                    modifier = Modifier.weight(1f),
                    onClick = { onNavigate(1) },
                )
            }
        }
        item {
            BriefingPanel(state.briefing, state.briefingLoading, onRefresh)
        }
        item {
            Surface(
                onClick = { onNavigate(2) },
                modifier = Modifier.fillMaxWidth(),
                color = Ink,
                contentColor = Color.White,
                shape = RoundedCornerShape(22.dp),
            ) {
                Row(Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        Text("继续流动", style = MaterialTheme.typography.titleLarge)
                        Text("把文字、照片或文件发回 Mac", color = Color.White.copy(alpha = 0.66f))
                    }
                    Icon(Icons.Outlined.ArrowForward, "前往发送")
                }
            }
        }
    }
}

@Composable
private fun HealthMetricCard(
    state: MainUiState,
    onRequestHealth: () -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val available = state.healthAvailability == HealthAvailability.AVAILABLE
    val value = when {
        state.healthLoading -> "…"
        state.healthPermissionGranted -> state.todaySteps?.toString() ?: "暂无"
        available -> "授权"
        state.healthAvailability == HealthAvailability.UPDATE_REQUIRED -> "更新"
        else -> "不可用"
    }
    val caption = when {
        state.healthPermissionGranted && state.todaySteps != null -> "Health Connect · 仅本机"
        state.healthPermissionGranted -> "暂无记录 · 授权后重新走几步"
        available -> "读取今天的步数"
        state.healthAvailability == HealthAvailability.UPDATE_REQUIRED -> "需更新 Health Connect"
        else -> "当前设备不支持"
    }
    MetricCard(
        icon = Icons.Outlined.DirectionsWalk,
        title = "今日步数",
        value = value,
        caption = caption,
        accent = Moss,
        modifier = modifier,
        onClick = when {
            !available -> null
            state.healthPermissionGranted -> onRefresh
            else -> onRequestHealth
        },
    )
}

@Composable
private fun MetricCard(
    icon: ImageVector,
    title: String,
    value: String,
    caption: String,
    accent: Color,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
) {
    Surface(
        modifier = modifier.heightIn(min = 168.dp),
        onClick = onClick ?: {},
        enabled = onClick != null,
        shape = RoundedCornerShape(22.dp),
        color = PaperRaised,
        border = androidx.compose.foundation.BorderStroke(1.dp, Line),
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.size(38.dp).background(accent.copy(alpha = 0.12f), CircleShape), contentAlignment = Alignment.Center) {
                Icon(icon, title, tint = accent, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.weight(1f))
            Text(value, style = MaterialTheme.typography.headlineMedium, maxLines = 1)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(title, style = MaterialTheme.typography.labelMedium)
                Text(caption, style = MaterialTheme.typography.bodySmall, maxLines = 2)
            }
        }
    }
}

@Composable
private fun BriefingPanel(briefing: DailyBriefing?, loading: Boolean, onRefresh: () -> Unit) {
    var expandedId by rememberSaveable(briefing?.id) { mutableStateOf<String?>(null) }
    Column(
        Modifier.fillMaxWidth().background(Moss, RoundedCornerShape(26.dp)).padding(vertical = 22.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        Row(Modifier.padding(horizontal = 22.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(34.dp).background(Acid, CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.AutoAwesome, null, tint = Ink, modifier = Modifier.size(18.dp))
            }
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text("ZX SIGNAL", style = MaterialTheme.typography.labelMedium, color = Color.White.copy(alpha = 0.68f))
                Text(briefing?.date ?: "今日日报", color = Color.White, fontWeight = FontWeight.SemiBold)
            }
            IconButton(onClick = onRefresh) { Icon(Icons.Outlined.Refresh, "刷新日报", tint = Color.White) }
        }
        when {
            loading -> Box(Modifier.fillMaxWidth().height(150.dp), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(color = Acid)
            }
            briefing == null -> Column(Modifier.padding(horizontal = 22.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("今天的日报还没有抵达", style = MaterialTheme.typography.titleLarge, color = Color.White)
                Text("日报可能仍在生成，或 Signal 暂时不可用。", color = Color.White.copy(alpha = 0.68f))
                OutlinedButton(onClick = onRefresh, colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White)) { Text("重新读取") }
            }
            else -> {
                Column(Modifier.padding(horizontal = 22.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(briefing.title, style = MaterialTheme.typography.headlineMedium, color = Color.White, maxLines = 3)
                    Text(briefing.summary, color = Color.White.copy(alpha = 0.72f), maxLines = 4, overflow = TextOverflow.Ellipsis)
                }
                LazyRow(
                    contentPadding = PaddingValues(horizontal = 16.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    itemsIndexed(briefing.items, key = { _, item -> item.id }) { index, item ->
                        BriefingStoryCard(
                            index = index,
                            item = item,
                            expanded = expandedId == item.id,
                            onToggle = { expandedId = if (expandedId == item.id) null else item.id },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun BriefingStoryCard(index: Int, item: BriefingItem, expanded: Boolean, onToggle: () -> Unit) {
    Surface(
        onClick = onToggle,
        modifier = Modifier.width(if (expanded) 312.dp else 276.dp).animateContentSize(),
        shape = RoundedCornerShape(18.dp),
        color = PaperRaised,
        contentColor = Ink,
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("${(index + 1).toString().padStart(2, '0')} · ${categoryLabel(item.category)}", style = MaterialTheme.typography.labelMedium, color = Moss)
                Spacer(Modifier.weight(1f))
                Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, if (expanded) "收起" else "展开")
            }
            Text(item.title, style = MaterialTheme.typography.titleLarge, maxLines = if (expanded) 5 else 3, overflow = TextOverflow.Ellipsis)
            Text(item.lede ?: item.summary, color = InkMuted, maxLines = if (expanded) 8 else 3, overflow = TextOverflow.Ellipsis)
            AnimatedVisibility(expanded) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    HorizontalDivider(color = Line)
                    Text("为什么重要", style = MaterialTheme.typography.labelMedium, color = Moss)
                    Text(item.implications ?: item.whyItMatters)
                    if (!item.watchNext.isNullOrBlank()) {
                        Text("继续观察", style = MaterialTheme.typography.labelMedium, color = Moss)
                        Text(item.watchNext)
                    }
                    item.sources.firstOrNull()?.let { Text(it.publisher ?: it.title, style = MaterialTheme.typography.bodySmall) }
                }
            }
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
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(58.dp).background(MossSoft, CircleShape), contentAlignment = Alignment.Center) {
                    Icon(Icons.Outlined.MoveToInbox, null, Modifier.size(28.dp), tint = Moss)
                }
                Text("收件箱是空的", style = MaterialTheme.typography.titleLarge)
                Text("从 Mac 投递的内容会出现在这里", style = MaterialTheme.typography.bodySmall)
            }
        }
        return
    }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 16.dp, top = 10.dp, end = 16.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Column(Modifier.padding(horizontal = 4.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                Text("收件箱", style = MaterialTheme.typography.headlineMedium)
                Text("${inbox.size} 项内容，按到达时间排列", color = InkMuted)
            }
        }
        items(inbox, key = { it.id }) { item ->
            InboxRow(item,
                onOpen = { payload ->
                    when (payload) {
                        is DropPayload.Text -> {
                            context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("zxtoolkit", payload.text))
                            viewModel.markClaimed(item)
                        }
                        is DropPayload.Url -> {
                            val url = normalizeHttpUrl(payload.url)
                            if (url == null) {
                                viewModel.showMessage("链接格式无效")
                            } else {
                                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
                                    .onSuccess { viewModel.markClaimed(item) }
                                    .onFailure { viewModel.showMessage("没有可打开此链接的应用") }
                            }
                        }
                        else -> Unit
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
private fun InboxRow(item: InboxEntity, onOpen: (DropPayload) -> Unit, onPreview: () -> Unit, onShare: () -> Unit, onSave: () -> Unit) {
    val payload = remember(item.payloadJson) { Json { ignoreUnknownKeys = true; classDiscriminator = "type" }.decodeFromString<DropPayload>(item.payloadJson) }
    val binary = payload is DropPayload.Image || payload is DropPayload.File
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = PaperRaised,
        shape = RoundedCornerShape(18.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, Line),
    ) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 15.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(42.dp).background(MossSoft, RoundedCornerShape(12.dp)), contentAlignment = Alignment.Center) {
                Icon(if (binary) Icons.Outlined.Description else if (payload is DropPayload.Url) Icons.Outlined.Link else Icons.Outlined.TextSnippet, null, tint = Moss)
            }
            Spacer(Modifier.width(13.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(payloadSummary(payload), maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium)
                Text("${item.senderName} · ${formatTime(item.createdAt)} · ${statusLabel(item.status)}", style = MaterialTheme.typography.bodySmall)
            }
            if (binary) {
                var menu by remember { mutableStateOf(false) }
                Box {
                    IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreHoriz, "更多操作") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        DropdownMenuItem({ Text("预览") }, { menu = false; onPreview() }, leadingIcon = { Icon(Icons.Outlined.Visibility, null) })
                        DropdownMenuItem({ Text("分享") }, { menu = false; onShare() }, leadingIcon = { Icon(Icons.Outlined.Share, null) })
                        DropdownMenuItem({ Text("保存") }, { menu = false; onSave() }, leadingIcon = { Icon(Icons.Outlined.SaveAlt, null) })
                    }
                }
            } else IconButton(onClick = { onOpen(payload) }) {
                Icon(if (payload is DropPayload.Url) Icons.Outlined.OpenInNew else Icons.Outlined.ContentCopy, "打开")
            }
        }
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
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, top = 12.dp, end = 20.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("发送到 Mac", style = MaterialTheme.typography.headlineMedium)
                Text("先写下内容，或从设备中选择一个文件。", color = InkMuted)
            }
        }
        item {
            OutlinedTextField(
                text,
                { text = it },
                Modifier.fillMaxWidth().heightIn(min = 180.dp),
                placeholder = { Text("粘贴文字或链接…") },
                maxLines = 8,
                shape = RoundedCornerShape(20.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = PaperRaised,
                    unfocusedContainerColor = PaperRaised,
                    focusedBorderColor = Moss,
                    unfocusedBorderColor = Line,
                ),
            )
        }
        item {
            Button(
                onClick = { viewModel.sendText(text); text = "" },
                enabled = text.isNotBlank(),
                modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp),
                shape = RoundedCornerShape(15.dp),
            ) {
                Icon(Icons.Outlined.NorthEast, null)
                Spacer(Modifier.width(8.dp))
                Text("发送文字")
            }
        }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SendTool(Icons.Outlined.Photo, "照片", Modifier.weight(1f)) { photo.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }
                SendTool(Icons.Outlined.PhotoCamera, "相机", Modifier.weight(1f)) {
                    val file = File(context.cacheDir, "outgoing/camera-${System.currentTimeMillis()}.jpg").also { it.parentFile?.mkdirs() }
                    cameraFile = file
                    camera.launch(FileProvider.getUriForFile(context, "${context.packageName}.files", file))
                }
                SendTool(Icons.Outlined.AttachFile, "文件", Modifier.weight(1f)) { document.launch(arrayOf("*/*")) }
            }
        }
        item { Text("文件通过临时加密连接传输；单个文件最大 100 MB。", style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable private fun SendTool(icon: ImageVector, label: String, modifier: Modifier = Modifier, action: () -> Unit) {
    Surface(
        onClick = action,
        modifier = modifier.heightIn(min = 92.dp),
        color = PaperRaised,
        shape = RoundedCornerShape(16.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, Line),
    ) {
        Column(Modifier.padding(12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Icon(icon, label, tint = Moss)
            Spacer(Modifier.height(8.dp))
            Text(label, style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable
private fun SettingsPage(state: MainUiState, viewModel: MainViewModel) {
    var name by remember(state.deviceName) { mutableStateOf(state.deviceName) }
    val context = LocalContext.current
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 20.dp, top = 12.dp, end = 20.dp, bottom = 32.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("设备与同步", style = MaterialTheme.typography.headlineMedium)
                Text("控制配对关系、后台状态和本机身份。", color = InkMuted)
            }
        }
        item {
            SettingsGroup {
                InfoRow("绑定 Mac", state.mac?.name ?: "未找到")
                HorizontalDivider(color = Line)
                InfoRow("连接", state.socketState)
                HorizontalDivider(color = Line)
                InfoRow("后台同步", "联网时约每 15 分钟")
            }
        }
        item {
            OutlinedTextField(
                name,
                { name = it },
                label = { Text("本机名称") },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(16.dp),
                trailingIcon = { IconButton(onClick = { viewModel.rename(name) }) { Icon(Icons.Outlined.Check, "保存名称") } },
            )
        }
        item {
            SettingsGroup {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text("Pulse", fontWeight = FontWeight.Medium)
                        Text("加密发送在线、精确电量、充电和今日步数", style = MaterialTheme.typography.bodySmall)
                    }
                    Switch(state.pulseEnabled, viewModel::setPulse)
                }
                HorizontalDivider(color = Line)
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.DirectionsWalk, null, tint = Moss)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Health Connect", fontWeight = FontWeight.Medium)
                        Text("授权后读取并同步今日精确步数", style = MaterialTheme.typography.bodySmall)
                    }
                    Text(if (state.healthPermissionGranted) "已授权" else "未授权", style = MaterialTheme.typography.labelMedium, color = InkMuted)
                }
            }
        }
        item {
            SettingsGroup {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Outlined.MusicNote, null, tint = Moss)
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text("网易云播放同步", fontWeight = FontWeight.Medium)
                        Text(
                            if (state.notificationAccessGranted) "MediaSession 已连接，仅采集网易云"
                            else "需要开启系统通知使用权",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    Switch(
                        checked = state.musicCaptureEnabled,
                        onCheckedChange = { enabled ->
                            viewModel.setMusicCapture(enabled)
                            if (enabled && !state.notificationAccessGranted) {
                                context.startActivity(Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                            }
                        },
                    )
                }
                HorizontalDivider(color = Line)
                Row(
                    Modifier.fillMaxWidth().clickable {
                        context.startActivity(Intent(android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                    }.padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("通知使用权", fontWeight = FontWeight.Medium)
                        Text(
                            if (state.notificationAccessGranted) "已授权；回到应用后自动刷新"
                            else "未授权；点击前往系统设置",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    Text(if (state.notificationAccessGranted) "已开启" else "去开启", style = MaterialTheme.typography.labelMedium, color = InkMuted)
                }
                HorizontalDivider(color = Line)
                InfoRow("本地同步队列", "${state.playbackPending} 待同步 · ${state.playbackDeadLetters} 待处理")
            }
        }
        item {
            OutlinedButton(viewModel::rotate, Modifier.fillMaxWidth().heightIn(min = 50.dp), shape = RoundedCornerShape(14.dp)) {
                Icon(Icons.Outlined.Autorenew, null)
                Spacer(Modifier.width(8.dp))
                Text("轮换凭证")
            }
        }
        item {
            TextButton(
                viewModel::unlink,
                Modifier.fillMaxWidth(),
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
            ) {
                Icon(Icons.Outlined.LinkOff, null)
                Spacer(Modifier.width(8.dp))
                Text("解除绑定")
            }
        }
    }
}

@Composable private fun SettingsGroup(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth().background(PaperRaised, RoundedCornerShape(18.dp)).border(1.dp, Line, RoundedCornerShape(18.dp)).padding(17.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        content = content,
    )
}

@Composable private fun InfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, Modifier.weight(1f), color = InkMuted)
        Text(value, fontWeight = FontWeight.Medium)
    }
}
@Composable private fun MessageLine(message: String?, modifier: Modifier = Modifier) {
    if (message != null) Text(
        message,
        modifier.background(Ink, RoundedCornerShape(12.dp)).padding(horizontal = 16.dp, vertical = 11.dp),
        color = Color.White,
        style = MaterialTheme.typography.bodyMedium,
    )
}

@Composable
private fun BrandLockup() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        BrandMark()
        Spacer(Modifier.width(10.dp))
        Column {
            Text("zxtoolkit", fontWeight = FontWeight.SemiBold)
            Text("PRIVATE DEVICE UTILITY", style = MaterialTheme.typography.labelMedium, color = InkMuted)
        }
    }
}

@Composable
private fun BrandMark() {
    Box(
        Modifier.size(36.dp).background(Ink, RoundedCornerShape(10.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Text("zx", color = Acid, fontWeight = FontWeight.Bold, fontSize = 14.sp)
    }
}

@Composable
private fun ConnectionPill(label: String) {
    val online = label == "实时在线"
    Row(
        Modifier.background(if (online) MossSoft else Color(0xFFE9E6DF), CircleShape).padding(horizontal = 10.dp, vertical = 7.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(7.dp).background(if (online) Moss else InkMuted, CircleShape))
        Text(label, style = MaterialTheme.typography.labelMedium, color = if (online) Moss else InkMuted)
    }
}

private fun payloadSummary(payload: DropPayload) = when (payload) { is DropPayload.Text -> payload.text; is DropPayload.Url -> payload.title ?: payload.url; is DropPayload.Image -> payload.fileName; is DropPayload.File -> payload.fileName }
private fun payloadName(item: InboxEntity) = runCatching { payloadSummary(Json { ignoreUnknownKeys = true; classDiscriminator = "type" }.decodeFromString<DropPayload>(item.payloadJson)) }.getOrDefault("zxtoolkit-file")
private fun statusLabel(status: String) = when (status) { "claimed" -> "已领取"; "opened" -> "已打开"; "expired" -> "已过期"; else -> "未读" }
private fun formatTime(value: String) = runCatching { DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(value)) }.getOrDefault(value)
private fun formatDay() = java.time.LocalDate.now().format(DateTimeFormatter.ofPattern("MM月dd日"))
private fun categoryLabel(value: String) = when (value) {
    "ai-engineering" -> "AI 工程"
    "markets" -> "市场"
    "zxlab" -> "zxlab"
    else -> value
}
