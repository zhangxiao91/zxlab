package dev.zxlab.zxtoolkit.work

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.BatteryManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.work.*
import dev.zxlab.zxtoolkit.R
import dev.zxlab.zxtoolkit.ZxToolkitApplication
import dev.zxlab.zxtoolkit.data.Repository
import dev.zxlab.zxtoolkit.health.HealthConnectRepository
import dev.zxlab.zxtoolkit.model.*
import dev.zxlab.zxtoolkit.net.ApiException
import kotlinx.serialization.decodeFromString
import java.io.File
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.TimeUnit
import java.util.UUID

class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as ZxToolkitApplication
        val repository = Repository(app, app.container.api, app.container.database, app.container.credentials)
        return try {
            repository.sync()
            syncPlayback(app)
            notifyNew(app)
            publishPulse(app, "recently_online")
            Result.success()
        } catch (error: ApiException) {
            if (error.status == 401) Result.failure() else Result.retry()
        } catch (_: Exception) { Result.retry() }
    }

    private suspend fun notifyNew(app: ZxToolkitApplication) {
        val dao = app.container.database.transfers()
        val ids = dao.unnotifiedIds()
        if (ids.isEmpty()) return
        if (android.os.Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            app.getSystemService(NotificationManager::class.java).notify(
                100,
                NotificationCompat.Builder(app, ZxToolkitApplication.NOTIFICATION_CHANNEL)
                    .setSmallIcon(R.drawable.ic_launcher).setContentTitle("收到新投递")
                    .setContentText("有 ${ids.size} 项内容等待查看").setAutoCancel(true).build()
            )
        }
        dao.markNotified(ids)
    }
}

class PlaybackSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as ZxToolkitApplication
        return syncPlayback(app)
    }

    companion object {
        fun enqueue(context: Context, force: Boolean = false) {
            val request = OneTimeWorkRequestBuilder<PlaybackSyncWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("playback-event-sync", playbackSyncPolicy(force), request)
        }
    }
}

internal fun playbackSyncPolicy(force: Boolean): ExistingWorkPolicy =
    if (force) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP

private suspend fun syncPlayback(app: ZxToolkitApplication): ListenableWorker.Result {
    val credential = app.container.credentials.credential() ?: return ListenableWorker.Result.failure()
    val dao = app.container.database.playbackEvents()
    val queued = dao.pending(100)
    if (queued.isEmpty()) return ListenableWorker.Result.success()
    val events = queued.map { app.container.api.json.decodeFromString<PlaybackEvent>(it.payloadJson) }
    return try {
        val response = app.container.api.publishPlaybackEvents(
            credential,
            PlaybackEventBatch(batchId = "batch_${UUID.randomUUID().toString().replace("-", "")}", sentAt = Instant.now().toString(), events = events),
        )
        val completed = response.accepted + response.duplicates
        if (completed.isNotEmpty()) dao.markSynced(completed)
        if (response.rejected.isNotEmpty()) dao.markFailed(response.rejected, "dead_letter", "SERVER_REJECTED")
        dao.deleteSyncedBefore(Instant.now().minus(30, ChronoUnit.DAYS).toString())
        if (dao.pendingCount() > 0) ListenableWorker.Result.retry() else ListenableWorker.Result.success()
    } catch (error: ApiException) {
        val permanentlyRejected = error.status == 400 || error.status == 422
        val dead = queued.filter { permanentlyRejected || it.attemptCount >= 19 }.map { it.eventId }
        val pending = queued.map { it.eventId } - dead.toSet()
        if (dead.isNotEmpty()) dao.markFailed(dead, "dead_letter", error.code)
        if (pending.isNotEmpty()) dao.markFailed(pending, "pending", error.code)
        when {
            error.status == 401 || error.status == 403 || permanentlyRejected -> ListenableWorker.Result.failure()
            else -> ListenableWorker.Result.retry()
        }
    } catch (_: Exception) {
        val dead = queued.filter { it.attemptCount >= 19 }.map { it.eventId }
        val pending = queued.map { it.eventId } - dead.toSet()
        if (dead.isNotEmpty()) dao.markFailed(dead, "dead_letter", "NETWORK_ERROR")
        if (pending.isNotEmpty()) dao.markFailed(pending, "pending", "NETWORK_ERROR")
        ListenableWorker.Result.retry()
    }
}

class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext as ZxToolkitApplication
        val id = inputData.getString(KEY_ID) ?: return Result.failure()
        val dao = app.container.database.transfers()
        val queued = dao.outbox(id) ?: return Result.failure()
        val credential = app.container.credentials.credential() ?: return fail(dao, id, "设备尚未配对")
        return try {
            var transferId = queued.transferId
            val payload = app.container.api.json.decodeFromString<DropPayload>(queued.payloadJson)
            if (transferId == null) {
                transferId = app.container.api.createDrop(credential, queued.targetId, payload, queued.localId).id
                dao.updateOutbox(id, transferId, "created")
            }
            if (queued.cachePath != null) {
                val file = File(queued.cachePath)
                if (!file.exists() || file.length() !in 1..MAX_FILE_BYTES) return fail(dao, id, "缓存文件不可用")
                try {
                    app.container.api.upload(credential, transferId, file, queued.mimeType ?: "application/octet-stream") { progress ->
                        setProgressAsync(workDataOf("progress" to progress))
                        notifyProgress(app, id, progress)
                    }
                } catch (error: ApiException) {
                    if (error.status == 409 || error.status == 410) {
                        transferId = app.container.api.createDrop(credential, queued.targetId, payload, queued.localId).id
                        dao.updateOutbox(id, transferId, "created")
                        app.container.api.upload(credential, transferId, file, queued.mimeType ?: "application/octet-stream") { progress ->
                            setProgressAsync(workDataOf("progress" to progress))
                            notifyProgress(app, id, progress)
                        }
                    } else throw error
                }
                file.delete()
            }
            dao.updateOutbox(id, transferId, "sent")
            notifyResult(app, true, "投递已发送")
            Result.success()
        } catch (error: ApiException) {
            if (error.status == 401) app.container.credentials.clear()
            dao.updateOutbox(id, queued.transferId, if (error.status in 400..499) "failed" else "queued", error.message)
            if (error.status in 400..499) { notifyResult(app, false, error.message); Result.failure() } else Result.retry()
        } catch (error: Exception) {
            dao.updateOutbox(id, queued.transferId, "queued", error.message)
            Result.retry()
        }
    }

    private suspend fun fail(dao: dev.zxlab.zxtoolkit.data.TransferDao, id: String, message: String): Result {
        dao.updateOutbox(id, null, "failed", message)
        return Result.failure()
    }

    companion object {
        const val KEY_ID = "outbox_id"
        fun enqueue(context: Context, id: String) {
            val request = OneTimeWorkRequestBuilder<UploadWorker>()
                .setInputData(workDataOf(KEY_ID to id))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork("upload-$id", ExistingWorkPolicy.KEEP, request)
        }
    }
}

suspend fun publishPulse(app: ZxToolkitApplication, presence: String) {
    if (!app.container.credentials.pulseEnabled()) return
    val credential = app.container.credentials.credential() ?: return
    val battery = app.getSystemService(BatteryManager::class.java)
    val percent = battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).coerceIn(0, 100)
    val state = app.registerReceiver(null, android.content.IntentFilter(Intent.ACTION_BATTERY_CHANGED))
    val status = state?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
    val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
    val steps = runCatching {
        val health = HealthConnectRepository(app)
        if (health.hasRequiredPermissions()) health.readTodaySteps() else null
    }.getOrNull()
    val now = Instant.now()
    app.container.api.publishPulse(
        credential,
        PulseSnapshot(
            device = PulseDevice(presence, percent, charging),
            activity = steps?.let { PulseActivity(it) },
            generatedAt = now.toString(),
            expiresAt = now.plus(60, ChronoUnit.MINUTES).toString(),
        ),
    )
}

private fun notifyResult(context: Context, success: Boolean, message: String) {
    if (android.os.Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
    context.getSystemService(NotificationManager::class.java).notify(
        (System.currentTimeMillis() % Int.MAX_VALUE).toInt(),
        NotificationCompat.Builder(context, ZxToolkitApplication.NOTIFICATION_CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher).setContentTitle(if (success) "zxtoolkit" else "投递失败")
            .setContentText(message).setAutoCancel(true).build()
    )
}

private fun notifyProgress(context: Context, id: String, progress: Int) {
    if (android.os.Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
    context.getSystemService(NotificationManager::class.java).notify(
        id.hashCode(),
        NotificationCompat.Builder(context, ZxToolkitApplication.NOTIFICATION_CHANNEL)
            .setSmallIcon(R.drawable.ic_launcher).setContentTitle("正在发送")
            .setContentText("$progress%").setOnlyAlertOnce(true).setOngoing(progress < 100)
            .setProgress(100, progress, false).build()
    )
}
