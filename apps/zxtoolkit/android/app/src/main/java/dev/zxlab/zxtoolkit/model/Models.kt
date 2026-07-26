package dev.zxlab.zxtoolkit.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

const val MAX_FILE_BYTES = 20L * 1024 * 1024

@Serializable
data class Device(
    val id: String,
    val name: String,
    val platform: String,
    val capabilities: List<String> = emptyList(),
    val createdAt: String,
    val lastSeenAt: String? = null,
    val revokedAt: String? = null,
    val credentialVersion: Int = 1,
)

@Serializable
data class DeviceCredential(val device: Device, val token: String)

@Serializable
sealed class DropPayload {
    @Serializable
    @SerialName("text")
    data class Text(val text: String) : DropPayload()

    @Serializable
    @SerialName("url")
    data class Url(val url: String, val title: String? = null) : DropPayload()

    @Serializable
    @SerialName("image")
    data class Image(
        val fileName: String,
        val mimeType: String,
        val size: Long,
        val width: Int? = null,
        val height: Int? = null,
    ) : DropPayload()

    @Serializable
    @SerialName("file")
    data class File(val fileName: String, val mimeType: String, val size: Long) : DropPayload()
}

@Serializable
data class DropItem(
    val id: String,
    val senderDeviceId: String,
    val senderDeviceName: String,
    val receiverDeviceId: String,
    val payload: DropPayload,
    val status: String,
    val createdAt: String,
    val expiresAt: String,
    val statusUpdatedAt: String? = null,
    val failureReason: String? = null,
)

@Serializable data class PairingCredentialResponse(val credential: DeviceCredential)
@Serializable data class PairingPreview(val desktopName: String, val mode: String, val expiresAt: String)
@Serializable data class DevicesResponse(val device: Device, val pairedDevices: List<Device>)
@Serializable data class InboxPage(val items: List<DropItem>, val nextCursor: String? = null)
@Serializable data class ItemResponse(val item: DropItem)
@Serializable data class TicketResponse(val deviceId: String, val ticket: String, val expiresAt: Long)

@Serializable
data class PulseSnapshot(
    val device: PulseDevice,
    val generatedAt: String,
    val expiresAt: String,
    val schemaVersion: Int = 1,
)

@Serializable data class PulseDevice(val presence: String, val batteryLevel: String, val charging: Boolean)

fun classifyText(value: String): DropPayload {
    val clean = value.trim()
    return normalizeHttpUrl(clean)?.let { DropPayload.Url(it) } ?: DropPayload.Text(clean)
}

fun normalizeHttpUrl(value: String): String? = value.trim().toHttpUrlOrNull()?.toString()

fun batteryBucket(percent: Int): String = when {
    percent >= 60 -> "high"
    percent >= 25 -> "medium"
    else -> "low"
}
