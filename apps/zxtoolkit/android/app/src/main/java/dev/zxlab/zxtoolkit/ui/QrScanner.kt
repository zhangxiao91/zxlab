package dev.zxlab.zxtoolkit.ui

import android.Manifest
import android.annotation.SuppressLint
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import dev.zxlab.zxtoolkit.net.parsePairingUrl
import java.util.concurrent.Executors

@Composable
@SuppressLint("UnsafeOptInUsageError")
fun PairingScanner(onPairingId: (String) -> Unit) {
    var allowed by remember { mutableStateOf(false) }
    var invalid by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { allowed = it }
    LaunchedEffect(Unit) { permission.launch(Manifest.permission.CAMERA) }
    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text("连接这台 Android", style = MaterialTheme.typography.headlineMedium)
        Text("在 Mac 的设备管理中选择添加设备，然后扫描二维码。")
        if (allowed) {
            ScannerPreview(onValue = { value ->
                val id = parsePairingUrl(value)
                if (id == null) invalid = true else onPairingId(id)
            })
        } else {
            Button(onClick = { permission.launch(Manifest.permission.CAMERA) }) { Text("允许相机并扫描") }
        }
        if (invalid) Text("二维码不是受信任的 zxtoolkit 配对地址", color = MaterialTheme.colorScheme.error)
    }
}

@Composable
@SuppressLint("UnsafeOptInUsageError")
private fun ScannerPreview(onValue: (String) -> Unit) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    val scanner = remember { BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()) }
    var consumed by remember { mutableStateOf(false) }
    DisposableEffect(Unit) { onDispose { scanner.close(); executor.shutdown() } }
    AndroidView(
        modifier = Modifier.fillMaxWidth().aspectRatio(1f),
        factory = { ctx ->
            PreviewView(ctx).also { view ->
                ProcessCameraProvider.getInstance(ctx).addListener({
                    val provider = ProcessCameraProvider.getInstance(ctx).get()
                    val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
                    val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                    analysis.setAnalyzer(executor) { proxy ->
                        val media = proxy.image
                        if (media == null || consumed) { proxy.close(); return@setAnalyzer }
                        scanner.process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees))
                            .addOnSuccessListener { codes -> codes.firstNotNullOfOrNull { it.rawValue }?.let { consumed = true; onValue(it) } }
                            .addOnCompleteListener { proxy.close() }
                    }
                    provider.unbindAll()
                    provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                }, ContextCompat.getMainExecutor(ctx))
            }
        },
    )
}
