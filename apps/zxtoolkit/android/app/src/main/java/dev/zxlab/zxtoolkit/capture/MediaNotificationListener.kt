package dev.zxlab.zxtoolkit.capture

import android.content.ComponentName
import android.media.MediaMetadata
import android.media.session.MediaController
import android.media.session.MediaSession
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.os.SystemClock
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import dev.zxlab.zxtoolkit.ZxToolkitApplication
import dev.zxlab.zxtoolkit.data.PlaybackEventEntity
import dev.zxlab.zxtoolkit.model.PlaybackEvent
import dev.zxlab.zxtoolkit.work.PlaybackSyncWorker
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import java.util.UUID

class MediaNotificationListener : NotificationListenerService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val sessions = mutableMapOf<MediaSession.Token, SessionAdapter>()
    private lateinit var manager: MediaSessionManager
    private val listener = MediaSessionManager.OnActiveSessionsChangedListener(::attach)

    override fun onListenerConnected() {
        super.onListenerConnected()
        manager = getSystemService(MediaSessionManager::class.java)
        val component = ComponentName(this, MediaNotificationListener::class.java)
        manager.addOnActiveSessionsChangedListener(listener, component)
        attach(runCatching { manager.getActiveSessions(component) }.getOrDefault(emptyList()))
    }

    private fun attach(active: List<MediaController>?) {
        val netease = active.orEmpty().filter { it.packageName == NETEASE_PACKAGE }
        val tokens = netease.mapTo(mutableSetOf()) { it.sessionToken }
        sessions.keys.filterNot(tokens::contains).forEach { token -> sessions.remove(token)?.close(true) }
        netease.filterNot { sessions.containsKey(it.sessionToken) }.forEach { controller ->
            SessionAdapter(controller).also {
                sessions[controller.sessionToken] = it
                it.open()
            }
        }
    }

    @Suppress("DEPRECATION")
    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn?.packageName != NETEASE_PACKAGE) return
        val token = sbn.notification.extras.getParcelable<MediaSession.Token>(android.app.Notification.EXTRA_MEDIA_SESSION) ?: return
        if (sessions.containsKey(token)) return
        SessionAdapter(MediaController(this, token)).also {
            sessions[token] = it
            it.open()
        }
    }

    private inner class SessionAdapter(private val controller: MediaController) : MediaController.Callback() {
        private val machine = PlaybackStateMachine()
        private var metadata: MediaMetadata? = null
        private var playback: PlaybackState? = null

        fun open() {
            controller.registerCallback(this)
            metadata = controller.metadata
            playback = controller.playbackState
            capture()
        }

        override fun onMetadataChanged(value: MediaMetadata?) {
            metadata = value
            capture()
        }

        override fun onPlaybackStateChanged(value: PlaybackState?) {
            playback = value
            capture()
        }

        override fun onSessionDestroyed() = close(true)

        fun close(destroyed: Boolean) {
            controller.unregisterCallback(this)
            if (destroyed) machine.destroyed(elapsedRealtimeMs = SystemClock.elapsedRealtime())?.let(::persist)
        }

        private fun capture() {
            val track = metadata?.toTrack() ?: return
            val state = playback
            machine.update(
                track = track,
                nextState = state.toState(),
                positionMs = state?.position?.takeIf { it >= 0 },
                speed = state?.playbackSpeed,
                elapsedRealtimeMs = SystemClock.elapsedRealtime(),
            ).forEach(::persist)
        }
    }

    private fun persist(event: PlaybackEvent) {
        scope.launch {
            val app = application as ZxToolkitApplication
            if (!app.container.credentials.musicCaptureEnabled()) return@launch
            app.container.database.playbackEvents().insert(
                PlaybackEventEntity(
                    localId = UUID.randomUUID().toString(),
                    eventId = event.eventId,
                    payloadJson = app.container.api.json.encodeToString(event),
                    occurredAt = event.occurredAt,
                ),
            )
            PlaybackSyncWorker.enqueue(app)
        }
    }

    override fun onDestroy() {
        sessions.values.forEach { it.close(false) }
        sessions.clear()
        if (::manager.isInitialized) manager.removeOnActiveSessionsChangedListener(listener)
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val NETEASE_PACKAGE = "com.netease.cloudmusic"
    }
}

private fun MediaMetadata.toTrack(): CapturedTrack? {
    val title = getString(MediaMetadata.METADATA_KEY_TITLE)
        ?: getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE)
        ?: return null
    val art = sequenceOf(
        getString(MediaMetadata.METADATA_KEY_ART_URI),
        getString(MediaMetadata.METADATA_KEY_ALBUM_ART_URI),
        getString(MediaMetadata.METADATA_KEY_DISPLAY_ICON_URI),
    ).filterNotNull().firstOrNull { it.startsWith("https://") }
    return CapturedTrack(
        mediaId = getString(MediaMetadata.METADATA_KEY_MEDIA_ID),
        title = title,
        artist = getString(MediaMetadata.METADATA_KEY_ARTIST) ?: getString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE),
        album = getString(MediaMetadata.METADATA_KEY_ALBUM),
        durationMs = getLong(MediaMetadata.METADATA_KEY_DURATION).takeIf { it > 0 },
        artworkUrl = art,
    )
}

private fun PlaybackState?.toState(): String = when (this?.state) {
    PlaybackState.STATE_PLAYING -> "playing"
    PlaybackState.STATE_PAUSED -> "paused"
    PlaybackState.STATE_STOPPED -> "stopped"
    PlaybackState.STATE_BUFFERING -> "buffering"
    PlaybackState.STATE_CONNECTING -> "connecting"
    PlaybackState.STATE_SKIPPING_TO_NEXT, PlaybackState.STATE_SKIPPING_TO_PREVIOUS, PlaybackState.STATE_SKIPPING_TO_QUEUE_ITEM -> "skipping"
    PlaybackState.STATE_ERROR -> "error"
    else -> "none"
}
