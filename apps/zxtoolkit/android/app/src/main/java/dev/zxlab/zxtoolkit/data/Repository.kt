package dev.zxlab.zxtoolkit.data

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import dev.zxlab.zxtoolkit.model.*
import dev.zxlab.zxtoolkit.net.ApiClient
import dev.zxlab.zxtoolkit.net.ApiException
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File
import java.util.UUID

class Repository(
    private val context: Context,
    private val api: ApiClient,
    private val database: AppDatabase,
    private val credentials: CredentialStore,
) {
    val inbox = database.transfers().inbox()

    suspend fun sync(): Int {
        val credential = credentials.credential() ?: return 0
        return withUnauthorizedHandling {
            var cursor: String? = null
            val collected = mutableListOf<DropItem>()
            do {
                val page = api.inbox(credential, cursor)
                collected += page.items
                cursor = page.nextCursor
            } while (cursor != null)
            val entities = collected.map(::toEntity)
            database.transfers().insertInbox(entities)
            entities.forEach { database.transfers().updateInbox(it.id, it.senderName, it.payloadJson, it.status, it.createdAt, it.expiresAt) }
            collected.size
        }
    }

    suspend fun pairedMac(): Device? {
        val credential = credentials.credential() ?: return null
        val response = withUnauthorizedHandling { api.devices(credential) }
        val mac = response.pairedDevices.firstOrNull { it.platform == "macos" && it.revokedAt == null }
        mac?.let { credentials.setDefaultMac(it.id) }
        return mac
    }

    suspend fun queueText(value: String, targetId: String): String {
        require(value.isNotBlank())
        return queue(classifyText(value), targetId, null, null)
    }

    suspend fun queueUri(uri: Uri, targetId: String): String {
        val metadata = contentMetadata(uri)
        require(metadata.size <= MAX_FILE_BYTES) { "单个文件不能超过 100 MB" }
        val cacheDir = File(context.cacheDir, "outgoing").apply { mkdirs() }
        val localId = UUID.randomUUID().toString()
        val file = File(cacheDir, localId)
        try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                file.outputStream().use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var total = 0L
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        total += read
                        require(total <= MAX_FILE_BYTES) { "单个文件不能超过 100 MB" }
                        output.write(buffer, 0, read)
                    }
                }
            } ?: error("无法读取所选文件")
            require(file.length() > 0) { "文件内容为空" }
        } catch (error: Exception) {
            file.delete()
            throw error
        }
        val payload = if (metadata.mimeType in IMAGE_MIME_TYPES) {
            DropPayload.Image(metadata.name, metadata.mimeType, file.length())
        } else {
            DropPayload.File(metadata.name, metadata.mimeType, file.length())
        }
        return queue(payload, targetId, file.absolutePath, metadata.mimeType, localId)
    }

    private suspend fun queue(payload: DropPayload, targetId: String, path: String?, mime: String?, id: String = UUID.randomUUID().toString()): String {
        database.transfers().upsertOutbox(OutboxEntity(id, targetId, api.json.encodeToString(payload), path, mime))
        return id
    }

    suspend fun downloadAndClaim(id: String): Pair<File, String> {
        val credential = credentials.credential() ?: error("设备尚未配对")
        val entity = database.transfers().inboxItem(id) ?: error("投递不存在")
        val payload = api.json.decodeFromString<DropPayload>(entity.payloadJson)
        val name = when (payload) {
            is DropPayload.Image -> payload.fileName
            is DropPayload.File -> payload.fileName
            else -> error("此投递没有文件")
        }
        val folder = File(context.cacheDir, "received").apply { mkdirs() }
        val file = File(folder, "${id}-${name.replace(Regex("[^A-Za-z0-9._-]"), "_")}")
        withUnauthorizedHandling { api.download(credential, id, file) }
        withUnauthorizedHandling { api.markStatus(credential, id, "claimed") }
        database.transfers().updateInboxStatus(id, "claimed")
        return file to when (payload) { is DropPayload.Image -> payload.mimeType; is DropPayload.File -> payload.mimeType; else -> "application/octet-stream" }
    }

    fun shareFile(file: File, mime: String): Intent {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.files", file)
        return Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    suspend fun markClaimed(item: InboxEntity) {
        val credential = credentials.credential() ?: return
        withUnauthorizedHandling { api.markStatus(credential, item.id, "claimed") }
        database.transfers().updateInboxStatus(item.id, "claimed")
    }

    private suspend fun <T> withUnauthorizedHandling(block: suspend () -> T): T = try { block() } catch (error: ApiException) {
        if (error.status == 401) credentials.clear()
        throw error
    }

    private fun toEntity(item: DropItem) = InboxEntity(
        item.id, item.senderDeviceName, api.json.encodeToString(item.payload), item.status, item.createdAt, item.expiresAt,
        notified = false,
    )

    private fun contentMetadata(uri: Uri): FileMetadata {
        val mime = context.contentResolver.getType(uri)?.lowercase() ?: "application/octet-stream"
        var name = "shared-file"
        var size = -1L
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                name = cursor.getString(0)?.take(160) ?: name
                if (!cursor.isNull(1)) size = cursor.getLong(1)
            }
        }
        if (size < 0) size = context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1
        return FileMetadata(name, mime, size)
    }

    private data class FileMetadata(val name: String, val mimeType: String, val size: Long)
    companion object { val IMAGE_MIME_TYPES = setOf("image/png", "image/jpeg", "image/webp", "image/gif") }
}
