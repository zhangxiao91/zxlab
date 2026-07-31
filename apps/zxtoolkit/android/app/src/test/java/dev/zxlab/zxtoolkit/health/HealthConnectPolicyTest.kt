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

    @Test
    fun `vivo system steps fill an empty Health Connect aggregate`() {
        assertEquals(2_532L, selectTodaySteps(null, "vivo", 2_532))
        assertEquals(2_532L, selectTodaySteps(0L, "VIVO", 2_532))
    }

    @Test
    fun `Health Connect remains the primary step source`() {
        assertEquals(6_832L, selectTodaySteps(6_832L, "vivo", 2_532))
    }

    @Test
    fun `vendor fallback is restricted to valid vivo daily values`() {
        assertEquals(0L, selectTodaySteps(null, "Google", 2_532))
        assertEquals(0L, selectTodaySteps(null, "vivo", -1))
        assertEquals(0L, selectTodaySteps(null, "vivo", 500_001))
    }
}
