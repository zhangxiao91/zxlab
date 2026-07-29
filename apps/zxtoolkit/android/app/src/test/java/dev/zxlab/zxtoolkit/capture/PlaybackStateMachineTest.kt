package dev.zxlab.zxtoolkit.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test
import java.time.Instant

class PlaybackStateMachineTest {
    private val track = CapturedTrack(null, "夜曲", "周杰伦", "十一月的萧邦", 230_000, null)
    private val now = Instant.parse("2026-07-30T12:00:00Z")

    @Test fun emitsStartPauseResumeWithoutDuplicatingMetadata() {
        val machine = PlaybackStateMachine()
        assertEquals("track_started", machine.update(track, "playing", 0, 1f, now, 100).single().eventType)
        assertEquals(0, machine.update(track, "playing", 1_000, 1f, now, 1_100).size)
        assertEquals("playback_paused", machine.update(track, "paused", 2_000, 0f, now, 2_100).single().eventType)
        assertEquals("playback_resumed", machine.update(track, "playing", 2_000, 1f, now, 3_100).single().eventType)
    }

    @Test fun updatesPlayingStateWhenMetadataArrivesBeforePlayback() {
        val machine = PlaybackStateMachine()
        assertEquals("track_started", machine.update(track, "none", null, null, now, 100).single().eventType)
        assertEquals("playback_resumed", machine.update(track, "playing", 0, 1f, now, 200).single().eventType)
    }

    @Test fun closesOldTrackBeforeStartingNewTrack() {
        val machine = PlaybackStateMachine()
        machine.update(track, "playing", 0, 1f, now, 100)
        val events = machine.update(track.copy(title = "晴天"), "playing", 0, 1f, now, 200)
        assertEquals(listOf("track_skipped", "track_started"), events.map { it.eventType })
        assertNotEquals(events[0].sessionId, events[1].sessionId)
    }
}
