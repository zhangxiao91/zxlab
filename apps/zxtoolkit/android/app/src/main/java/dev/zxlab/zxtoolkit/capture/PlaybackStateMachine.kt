package dev.zxlab.zxtoolkit.capture

import dev.zxlab.zxtoolkit.model.PlaybackEvent
import dev.zxlab.zxtoolkit.model.PlaybackPosition
import dev.zxlab.zxtoolkit.model.PlaybackTrack
import java.security.MessageDigest
import java.text.Normalizer
import java.time.Instant
import java.util.UUID

data class CapturedTrack(
    val mediaId: String?,
    val title: String,
    val artist: String?,
    val album: String?,
    val durationMs: Long?,
    val artworkUrl: String?,
)

class PlaybackStateMachine {
    private var current: CapturedTrack? = null
    private var fingerprint: String? = null
    private var sessionId: String? = null
    private var state: String = "none"

    fun update(
        track: CapturedTrack?,
        nextState: String,
        positionMs: Long?,
        speed: Float?,
        occurredAt: Instant = Instant.now(),
        elapsedRealtimeMs: Long,
    ): List<PlaybackEvent> {
        if (track == null || track.title.isBlank()) return emptyList()
        val nextFingerprint = Companion.fingerprint(track)
        val events = mutableListOf<PlaybackEvent>()
        if (fingerprint != null && fingerprint != nextFingerprint) {
            events += event("track_skipped", current!!, state = "stopped", positionMs, speed, occurredAt, elapsedRealtimeMs)
            sessionId = null
        }
        if (fingerprint != nextFingerprint || sessionId == null) {
            current = track
            fingerprint = nextFingerprint
            sessionId = token("ses")
            events += event("track_started", track, nextState, positionMs, speed, occurredAt, elapsedRealtimeMs)
        } else if (state != nextState) {
            val type = when {
                nextState == "playing" && state != "playing" -> "playback_resumed"
                nextState == "paused" -> "playback_paused"
                nextState == "stopped" -> "track_ended"
                else -> null
            }
            if (type != null) events += event(type, track, nextState, positionMs, speed, occurredAt, elapsedRealtimeMs)
        }
        current = track
        state = nextState
        return events
    }

    fun destroyed(occurredAt: Instant = Instant.now(), elapsedRealtimeMs: Long): PlaybackEvent? {
        val track = current ?: return null
        val result = event("session_destroyed", track, "stopped", null, null, occurredAt, elapsedRealtimeMs)
        current = null
        fingerprint = null
        sessionId = null
        state = "none"
        return result
    }

    private fun event(
        type: String,
        track: CapturedTrack,
        state: String,
        positionMs: Long?,
        speed: Float?,
        occurredAt: Instant,
        elapsedRealtimeMs: Long,
    ) = PlaybackEvent(
        eventId = token("evt"),
        sessionId = requireNotNull(sessionId),
        eventType = type,
        mediaId = track.mediaId,
        fingerprint = requireNotNull(fingerprint),
        track = PlaybackTrack(track.title, track.artist, track.album, track.durationMs, track.artworkUrl),
        playback = PlaybackPosition(state, positionMs, speed),
        occurredAt = occurredAt.toString(),
        elapsedRealtimeMs = elapsedRealtimeMs,
    )

    companion object {
        fun fingerprint(track: CapturedTrack): String {
            val normalized = listOf(track.title, track.artist.orEmpty(), track.album.orEmpty()).joinToString("\u0000") {
                Normalizer.normalize(it, Normalizer.Form.NFKC).trim().replace(Regex("\\s+"), " ").lowercase()
            }
            val durationBucket = (track.durationMs ?: 0L) / 5_000L
            return MessageDigest.getInstance("SHA-256").digest("$normalized\u0000$durationBucket".toByteArray())
                .joinToString("") { "%02x".format(it) }
        }

        private fun token(prefix: String) = "${prefix}_${UUID.randomUUID().toString().replace("-", "")}"
    }
}
