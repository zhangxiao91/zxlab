package dev.zxlab.zxtoolkit.health

import org.junit.Assert.assertEquals
import org.junit.Test

class HealthConnectPolicyTest {
    @Test
    fun `background-capable devices request both steps and background read permissions`() {
        assertEquals(
            setOf("read-steps", "read-health-in-background"),
            requiredHealthPermissions(
                stepsPermission = "read-steps",
                backgroundReadPermission = "read-health-in-background",
                backgroundReadAvailable = true,
            ),
        )
    }

    @Test
    fun `devices without background feature only request steps permission`() {
        assertEquals(
            setOf("read-steps"),
            requiredHealthPermissions(
                stepsPermission = "read-steps",
                backgroundReadPermission = "read-health-in-background",
                backgroundReadAvailable = false,
            ),
        )
    }

    @Test
    fun `missing aggregate data is a precise zero rather than an omitted activity`() {
        assertEquals(0L, stepsOrZero(null))
        assertEquals(6_832L, stepsOrZero(6_832L))
    }
}
