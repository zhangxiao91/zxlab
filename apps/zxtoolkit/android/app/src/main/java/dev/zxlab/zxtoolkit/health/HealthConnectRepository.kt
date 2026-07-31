package dev.zxlab.zxtoolkit.health

import android.content.Context
import android.os.Build
import android.provider.Settings
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
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

internal fun requiredHealthPermissions(
    stepsPermission: String,
    backgroundReadPermission: String,
    backgroundReadAvailable: Boolean,
): Set<String> = buildSet {
    add(stepsPermission)
    if (backgroundReadAvailable) add(backgroundReadPermission)
}

internal fun stepsOrZero(steps: Long?): Long = steps ?: 0L

internal fun selectTodaySteps(
    healthConnectSteps: Long?,
    manufacturer: String,
    vivoSystemSteps: Int,
): Long {
    val standardSteps = stepsOrZero(healthConnectSteps)
    if (standardSteps > 0L || !manufacturer.equals("vivo", ignoreCase = true)) return standardSteps
    return vivoSystemSteps.takeIf { it in 0..500_000 }?.toLong() ?: standardSteps
}

class HealthConnectRepository(private val context: Context) {
    val stepsPermission: String = HealthPermission.getReadPermission(StepsRecord::class)
    val backgroundReadPermission: String = HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND

    fun availability(): HealthAvailability = when (HealthConnectClient.getSdkStatus(context)) {
        HealthConnectClient.SDK_AVAILABLE -> HealthAvailability.AVAILABLE
        HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> HealthAvailability.UPDATE_REQUIRED
        else -> HealthAvailability.UNAVAILABLE
    }

    suspend fun hasStepsPermission(): Boolean {
        if (availability() != HealthAvailability.AVAILABLE) return false
        return stepsPermission in client().permissionController.getGrantedPermissions()
    }

    fun requiredPermissions(): Set<String> = requiredHealthPermissions(
        stepsPermission = stepsPermission,
        backgroundReadPermission = backgroundReadPermission,
        backgroundReadAvailable = backgroundReadAvailable(),
    )

    suspend fun hasRequiredPermissions(): Boolean {
        if (availability() != HealthAvailability.AVAILABLE) return false
        return client().permissionController.getGrantedPermissions().containsAll(requiredPermissions())
    }

    suspend fun readTodaySteps(
        date: LocalDate = LocalDate.now(),
        zoneId: ZoneId = ZoneId.systemDefault(),
        now: Instant = Instant.now(),
    ): Long {
        val start = date.atStartOfDay(zoneId).toInstant()
        val endOfDate = date.plusDays(1).atStartOfDay(zoneId).toInstant()
        val end = if (date == LocalDate.now(zoneId)) minOf(now, endOfDate) else endOfDate
        if (end <= start) return 0L
        val result = client().aggregate(
            AggregateRequest(
                metrics = setOf(StepsRecord.COUNT_TOTAL),
                timeRangeFilter = TimeRangeFilter.between(start, end),
            ),
        )
        val vivoSystemSteps = if (Build.MANUFACTURER.equals("vivo", ignoreCase = true)) {
            runCatching {
                Settings.System.getInt(context.contentResolver, VIVO_TODAY_STEPS_SETTING, -1)
            }.getOrDefault(-1)
        } else {
            -1
        }
        return selectTodaySteps(
            healthConnectSteps = result[StepsRecord.COUNT_TOTAL],
            manufacturer = Build.MANUFACTURER,
            vivoSystemSteps = vivoSystemSteps,
        )
    }

    private fun backgroundReadAvailable(): Boolean =
        availability() == HealthAvailability.AVAILABLE &&
            client().features.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) ==
            HealthConnectFeatures.FEATURE_STATUS_AVAILABLE

    private fun client(): HealthConnectClient = HealthConnectClient.getOrCreate(context)

    private companion object {
        const val VIVO_TODAY_STEPS_SETTING = "vivo_settings_realtime_steps"
    }
}
