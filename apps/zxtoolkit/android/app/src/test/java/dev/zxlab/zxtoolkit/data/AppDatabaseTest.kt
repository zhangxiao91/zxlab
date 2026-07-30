package dev.zxlab.zxtoolkit.data

import android.app.Application
import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import dev.zxlab.zxtoolkit.ZxToolkitApplication
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class)
class AppDatabaseTest {
    private lateinit var db: AppDatabase
    @Before fun setup() { db = Room.inMemoryDatabaseBuilder(ApplicationProvider.getApplicationContext<Context>(), AppDatabase::class.java).allowMainThreadQueries().build() }
    @After fun close() = db.close()

    @Test fun deduplicatesAndRetainsNotificationState() = runTest {
        val first = InboxEntity("drop-1", "Mac", "{}", "delivered", "2026-01-01", "2026-01-02")
        db.transfers().insertInbox(listOf(first, first))
        db.transfers().markNotified(listOf("drop-1"))
        db.transfers().insertInbox(listOf(first.copy(status = "opened")))
        db.transfers().updateInbox("drop-1", "Mac", "{}", "opened", "2026-01-01", "2026-01-02")
        val rows = db.transfers().inbox().first()
        assertEquals(1, rows.size)
        assertTrue(rows.single().notified)
        assertEquals("opened", rows.single().status)
    }

    @Test fun migrationRequeuesPlaybackEventsRejectedByTheOldWireContract() = runTest {
        val dao = db.playbackEvents()
        dao.insert(
            PlaybackEventEntity(
                localId = "local-1",
                eventId = "evt_12345678",
                payloadJson = "{}",
                occurredAt = "2026-07-30T12:00:00Z",
            ),
        )
        dao.markFailed(listOf("evt_12345678"), "dead_letter", "INVALID_PLAYBACK_BATCH")

        ZxToolkitApplication.MIGRATION_2_3.migrate(db.openHelper.writableDatabase)

        db.openHelper.writableDatabase.query(
            "SELECT syncState, attemptCount, lastErrorCode FROM playback_events WHERE eventId = ?",
            arrayOf("evt_12345678"),
        ).use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals("pending", cursor.getString(0))
            assertEquals(0, cursor.getInt(1))
            assertTrue(cursor.isNull(2))
        }
    }
}
