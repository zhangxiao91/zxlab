package dev.zxlab.zxtoolkit.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

const val MAX_FILE_BYTES = 100_000_000L

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
    val activity: PulseActivity? = null,
    val generatedAt: String,
    val expiresAt: String,
    val schemaVersion: Int = 1,
)

@Serializable data class PulseDevice(val presence: String, val batteryPercent: Int, val charging: Boolean)
@Serializable data class PulseActivity(val steps: Long? = null)

@Serializable
data class EncryptedEnvelope(
    val schemaVersion: Int = 1,
    val algorithm: String = "A256GCM",
    val iv: String,
    val ciphertext: String,
)

@Serializable
data class PlaybackTrack(
    val title: String,
    val artist: String? = null,
    val album: String? = null,
    val durationMs: Long? = null,
    val artworkUrl: String? = null,
)

@Serializable
data class PlaybackPosition(
    val state: String,
    val positionMs: Long? = null,
    val speed: Float? = null,
)

@Serializable
data class PlaybackEvent(
    val eventId: String,
    val sessionId: String,
    val eventType: String,
    val packageName: String = "com.netease.cloudmusic",
    val mediaId: String? = null,
    val fingerprint: String,
    val track: PlaybackTrack,
    val playback: PlaybackPosition,
    val occurredAt: String,
    val elapsedRealtimeMs: Long,
)

@Serializable
data class PlaybackEventBatch(
    val schemaVersion: Int = 1,
    val batchId: String,
    val sentAt: String,
    val events: List<PlaybackEvent>,
)

@Serializable
data class PlaybackBatchResponse(
    val batchId: String,
    val accepted: List<String> = emptyList(),
    val duplicates: List<String> = emptyList(),
    val rejected: List<String> = emptyList(),
    val serverTime: String,
)

@Serializable
data class DailyBriefing(
    val id: String,
    val date: String,
    val status: String,
    val title: String,
    val summary: String,
    val generatedAt: String,
    val items: List<BriefingItem> = emptyList(),
)

@Serializable
data class BriefingItem(
    val id: String,
    val category: String,
    val title: String,
    val lede: String? = null,
    val nutGraf: String? = null,
    val summary: String,
    val whyItMatters: String,
    val keyFacts: List<String> = emptyList(),
    val implications: String? = null,
    val watchNext: String? = null,
    val sources: List<BriefingSource> = emptyList(),
)

@Serializable
data class BriefingSource(
    val id: String,
    val title: String,
    val url: String,
    val publisher: String? = null,
)

fun classifyText(value: String): DropPayload {
    val clean = value.trim()
    return normalizeHttpUrl(clean)?.let { DropPayload.Url(it) } ?: DropPayload.Text(clean)
}

fun normalizeHttpUrl(value: String): String? = value.trim().toHttpUrlOrNull()?.toString()
