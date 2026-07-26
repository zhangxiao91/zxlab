package dev.zxlab.zxtoolkit

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import androidx.room.Room
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
        val database = Room.databaseBuilder(this, AppDatabase::class.java, "zxtoolkit.db").build()
        val credentials = CredentialStore(this, api.json)
        container = AppContainer(api, database, credentials)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(NOTIFICATION_CHANNEL, "传输", NotificationManager.IMPORTANCE_DEFAULT)
        )
        scheduleBackgroundSync()
    }

    private fun scheduleBackgroundSync() {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("zxtoolkit-sync", ExistingPeriodicWorkPolicy.UPDATE, request)
    }

    companion object { const val NOTIFICATION_CHANNEL = "transfers" }
}

data class AppContainer(val api: ApiClient, val database: AppDatabase, val credentials: CredentialStore)
