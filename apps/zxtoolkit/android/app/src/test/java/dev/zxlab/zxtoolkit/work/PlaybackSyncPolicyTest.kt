package dev.zxlab.zxtoolkit.work

import androidx.work.ExistingWorkPolicy
import org.junit.Assert.assertEquals
import org.junit.Test

class PlaybackSyncPolicyTest {
    @Test
    fun `regular captures keep the active low-power sync`() {
        assertEquals(ExistingWorkPolicy.KEEP, playbackSyncPolicy(force = false))
    }

    @Test
    fun `startup recovery replaces an old backed-off sync`() {
        assertEquals(ExistingWorkPolicy.REPLACE, playbackSyncPolicy(force = true))
    }
}
