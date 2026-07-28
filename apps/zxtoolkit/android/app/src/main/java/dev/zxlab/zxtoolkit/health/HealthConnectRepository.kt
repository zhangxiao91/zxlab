package dev.zxlab.zxtoolkit.health

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.request.AggregateRequest
import androidx.health.connect.client.time.TimeRangeFilter
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

enum class HealthAvailability {
    AVAILABLE,
    UPDATE_REQUIRED,
    UNAVAILABLE,
}

class HealthConnectRepository(private val context: Context) {
    val stepsPermission: String = HealthPermission.getReadPermission(StepsRecord::class)

    fun availability(): HealthAvailability = when (HealthConnectClient.getSdkStatus(context)) {
        HealthConnectClient.SDK_AVAILABLE -> HealthAvailability.AVAILABLE
        HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> HealthAvailability.UPDATE_REQUIRED
        else -> HealthAvailability.UNAVAILABLE
    }

    suspend fun hasStepsPermission(): Boolean {
        if (availability() != HealthAvailability.AVAILABLE) return false
        return stepsPermission in client().permissionController.getGrantedPermissions()
    }

    suspend fun readTodaySteps(
        date: LocalDate = LocalDate.now(),
        zoneId: ZoneId = ZoneId.systemDefault(),
        now: Instant = Instant.now(),
    ): Long? {
        val start = date.atStartOfDay(zoneId).toInstant()
        val endOfDate = date.plusDays(1).atStartOfDay(zoneId).toInstant()
        val end = if (date == LocalDate.now(zoneId)) minOf(now, endOfDate) else endOfDate
        if (end <= start) return null
        val result = client().aggregate(
            AggregateRequest(
                metrics = setOf(StepsRecord.COUNT_TOTAL),
                timeRangeFilter = TimeRangeFilter.between(start, end),
            ),
        )
        return result[StepsRecord.COUNT_TOTAL]
    }

    private fun client(): HealthConnectClient = HealthConnectClient.getOrCreate(context)
}
