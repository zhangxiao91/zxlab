package dev.zxlab.zxtoolkit

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import androidx.room.Room
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.work.*
import dev.zxlab.zxtoolkit.data.AppDatabase
import dev.zxlab.zxtoolkit.data.CredentialStore
import dev.zxlab.zxtoolkit.net.ApiClient
import dev.zxlab.zxtoolkit.work.SyncWorker
import java.util.concurrent.TimeUnit

class ZxToolkitApplication : Application() {
    lateinit var container: AppContainer
        private set

    override fun onCreate() {
        super.onCreate()
        val api = ApiClient()
        val database = Room.databaseBuilder(this, AppDatabase::class.java, "zxtoolkit.db")
            .addMigrations(MIGRATION_1_2)
            .build()
        val credentials = CredentialStore(this, api.json)
        container = AppContainer(api, database, credentials)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(NOTIFICATION_CHANNEL, "传输", NotificationManager.IMPORTANCE_DEFAULT)
        )
        scheduleBackgroundSync()
    }

    private fun scheduleBackgroundSync() {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .setRequiresBatteryNotLow(true)
                    .build(),
            )
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("zxtoolkit-sync", ExistingPeriodicWorkPolicy.UPDATE, request)
    }

    companion object {
        const val NOTIFICATION_CHANNEL = "transfers"
        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """CREATE TABLE IF NOT EXISTS playback_events (
                        localId TEXT NOT NULL PRIMARY KEY,
                        eventId TEXT NOT NULL,
                        payloadJson TEXT NOT NULL,
                        occurredAt TEXT NOT NULL,
                        syncState TEXT NOT NULL,
                        attemptCount INTEGER NOT NULL,
                        lastErrorCode TEXT
                    )""",
                )
                db.execSQL("CREATE UNIQUE INDEX IF NOT EXISTS index_playback_events_eventId ON playback_events(eventId)")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_playback_events_syncState_occurredAt ON playback_events(syncState, occurredAt)")
            }
        }
    }
}

data class AppContainer(val api: ApiClient, val database: AppDatabase, val credentials: CredentialStore)
