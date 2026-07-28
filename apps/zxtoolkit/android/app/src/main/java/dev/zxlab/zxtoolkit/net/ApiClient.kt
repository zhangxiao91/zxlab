package dev.zxlab.zxtoolkit.net

import dev.zxlab.zxtoolkit.BuildConfig
import dev.zxlab.zxtoolkit.model.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.IOException
import java.time.LocalDate
import okio.BufferedSink
import okio.buffer

class ApiException(val code: String, override val message: String, val status: Int) : IOException(message)

class ApiClient(
    private val origin: String = BuildConfig.API_ORIGIN,
    val http: OkHttpClient = OkHttpClient(),
    val json: Json = Json { ignoreUnknownKeys = true; classDiscriminator = "type"; encodeDefaults = true },
) {
    suspend fun confirmPairing(pairingId: String, name: String): DeviceCredential =
        call<PairingCredentialResponse>("/api/pairing/sessions/$pairingId/confirm", "POST", ConfirmBody(name)).credential

    suspend fun pairingPreview(pairingId: String): PairingPreview =
        call("/api/pairing/sessions/$pairingId/preview")

    suspend fun devices(credential: DeviceCredential): DevicesResponse =
        call("/api/devices", credential = credential)

    suspend fun inbox(credential: DeviceCredential, cursor: String? = null): InboxPage =
        call("/api/inbox?limit=50${cursor?.let { "&cursor=${java.net.URLEncoder.encode(it, "UTF-8")}" } ?: ""}", credential = credential)

    suspend fun createDrop(credential: DeviceCredential, receiverId: String, payload: DropPayload): DropItem =
        call<ItemResponse>("/api/transfers", "POST", CreateDropBody(receiverId, payload), credential).item

    suspend fun upload(credential: DeviceCredential, transferId: String, file: File, mimeType: String, onProgress: (Int) -> Unit = {}): DropItem = withContext(Dispatchers.IO) {
        execute<ItemResponse>(Request.Builder()
            .url(url("/api/transfers/$transferId/content"))
            .headers(authHeaders(credential))
            .post(ProgressRequestBody(file.asRequestBody(mimeType.toMediaType()), onProgress))
            .build()).item
    }

    suspend fun download(credential: DeviceCredential, transferId: String, destination: File): File = withContext(Dispatchers.IO) {
        val response = http.newCall(Request.Builder().url(url("/api/transfers/$transferId/download")).headers(authHeaders(credential)).build()).execute()
        if (!response.isSuccessful) throw problem(response)
        response.body?.byteStream()?.use { input -> destination.outputStream().use(input::copyTo) }
            ?: throw ApiException("EMPTY_BODY", "没有读取到文件", response.code)
        destination
    }

    suspend fun markStatus(credential: DeviceCredential, transferId: String, status: String): DropItem =
        call<ItemResponse>("/api/transfers/$transferId/status", "PATCH", StatusBody(status), credential).item

    suspend fun ticket(credential: DeviceCredential): TicketResponse =
        call("/api/inbox/events/ticket", "POST", UnitBody(), credential)

    suspend fun rename(credential: DeviceCredential, name: String): Device =
        call<DeviceResponse>("/api/devices/${credential.device.id}", "PATCH", RenameBody(name), credential).device

    suspend fun rotate(credential: DeviceCredential): DeviceCredential =
        call<PairingCredentialResponse>("/api/devices/credential/rotate", "POST", UnitBody(), credential).credential

    suspend fun unlink(credential: DeviceCredential, targetId: String) {
        call<RemovedResponse>("/api/devices/$targetId", "DELETE", credential = credential)
    }

    suspend fun publishPulse(credential: DeviceCredential, snapshot: PulseSnapshot) {
        call<AcceptedResponse>("/api/pulse/snapshots", "POST", snapshot, credential)
    }

    suspend fun todayBriefing(credential: DeviceCredential, date: LocalDate = LocalDate.now()): DailyBriefing =
        call("/api/briefings/today?date=$date", credential = credential)

    fun socketUrl(ticket: TicketResponse): String = url("/api/inbox/events?deviceId=${ticket.deviceId}&ticket=${ticket.ticket}")
        .replaceFirst("https://", "wss://").replaceFirst("http://", "ws://")

    private suspend inline fun <reified T> call(
        path: String,
        method: String = "GET",
        body: Any? = null,
        credential: DeviceCredential? = null,
    ): T = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(url(path))
        if (credential != null) builder.headers(authHeaders(credential))
        val requestBody = body?.let { json.encodeToString(serializerFor(it), it).toRequestBody(JSON) }
        builder.method(method, if (method == "GET" || method == "DELETE") null else requestBody ?: EMPTY)
        execute(builder.build())
    }

    private inline fun <reified T> execute(request: Request): T {
        val response = try { http.newCall(request).execute() } catch (error: IOException) {
            throw ApiException("NETWORK_ERROR", "无法连接传输服务", 0)
        }
        response.use {
            if (!it.isSuccessful) throw problem(it)
            val text = it.body?.string() ?: "{}"
            return json.decodeFromString(text)
        }
    }

    @Suppress("UNCHECKED_CAST")
    private fun serializerFor(value: Any) = when (value) {
        is ConfirmBody -> ConfirmBody.serializer()
        is CreateDropBody -> CreateDropBody.serializer()
        is StatusBody -> StatusBody.serializer()
        is RenameBody -> RenameBody.serializer()
        is PulseSnapshot -> PulseSnapshot.serializer()
        is UnitBody -> UnitBody.serializer()
        else -> error("Unsupported request body ${value::class}")
    } as kotlinx.serialization.SerializationStrategy<Any>

    private fun authHeaders(value: DeviceCredential) = Headers.headersOf(
        "Authorization", "Bearer ${value.token}",
        "X-Device-Id", value.device.id,
    )

    private fun problem(response: Response): ApiException {
        val raw = response.body?.string().orEmpty()
        val parsed = runCatching { json.decodeFromString<ApiProblem>(raw) }.getOrNull()
        return ApiException(parsed?.error?.code ?: "REQUEST_FAILED", parsed?.error?.message ?: "请求失败", response.code)
    }

    private fun url(path: String) = origin.trimEnd('/') + path

    companion object {
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val EMPTY = "{}".toRequestBody(JSON)
    }
}

private class ProgressRequestBody(private val delegate: RequestBody, private val callback: (Int) -> Unit) : RequestBody() {
    override fun contentType() = delegate.contentType()
    override fun contentLength() = delegate.contentLength()
    override fun writeTo(sink: BufferedSink) {
        val total = contentLength().coerceAtLeast(1)
        val forwarding = object : okio.ForwardingSink(sink) {
            var written = 0L
            var last = -1
            override fun write(source: okio.Buffer, byteCount: Long) {
                super.write(source, byteCount)
                written += byteCount
                val progress = (written * 100 / total).toInt().coerceIn(0, 100)
                if (progress != last) { last = progress; callback(progress) }
            }
        }
        val buffered = forwarding.buffer()
        delegate.writeTo(buffered)
        buffered.flush()
    }
}

@Serializable private data class ConfirmBody(val name: String, val platform: String = "android")
@Serializable private data class CreateDropBody(val receiverDeviceId: String, val payload: DropPayload)
@Serializable private data class StatusBody(val status: String)
@Serializable private data class RenameBody(val name: String)
@Serializable private class UnitBody
@Serializable private data class DeviceResponse(val device: Device)
@Serializable private data class RemovedResponse(val removed: Boolean)
@Serializable private data class AcceptedResponse(val accepted: Boolean)
@Serializable private data class ApiProblem(val error: ErrorBody)
@Serializable private data class ErrorBody(val code: String, val message: String)

fun parsePairingUrl(value: String, appOrigin: String = BuildConfig.APP_ORIGIN): String? {
    val scanned = runCatching { java.net.URI(value.trim()) }.getOrNull() ?: return null
    val allowed = runCatching { java.net.URI(appOrigin) }.getOrNull() ?: return null
    if (scanned.scheme != "https" || scanned.host != allowed.host || scanned.port != allowed.port) return null
    val match = Regex("^/pair/([a-f0-9-]{36})/?$").matchEntire(scanned.path ?: "") ?: return null
    return match.groupValues[1]
}
