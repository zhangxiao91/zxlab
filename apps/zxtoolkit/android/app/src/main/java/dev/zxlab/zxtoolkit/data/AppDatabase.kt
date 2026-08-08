package dev.zxlab.zxtoolkit.data

import androidx.room.*
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "inbox")
data class InboxEntity(
    @PrimaryKey val id: String,
    val senderName: String,
    val payloadJson: String,
    val status: String,
    val createdAt: String,
    val expiresAt: String,
    val notified: Boolean = false,
)

@Entity(tableName = "outbox")
data class OutboxEntity(
    @PrimaryKey val localId: String,
    val targetId: String,
    val payloadJson: String,
    val cachePath: String? = null,
    val mimeType: String? = null,
    val transferId: String? = null,
    val stage: String = "queued",
    val error: String? = null,
    val createdAt: Long = System.currentTimeMillis(),
)

@Entity(
    tableName = "playback_events",
    indices = [
        Index(value = ["eventId"], unique = true),
        Index(value = ["syncState", "occurredAt"]),
    ],
)
data class PlaybackEventEntity(
    @PrimaryKey val localId: String,
    val eventId: String,
    val payloadJson: String,
    val occurredAt: String,
    val syncState: String = "pending",
    val attemptCount: Int = 0,
    val lastErrorCode: String? = null,
)

@Dao
interface TransferDao {
    @Query("SELECT * FROM inbox ORDER BY createdAt DESC") fun inbox(): Flow<List<InboxEntity>>
    @Query("SELECT * FROM inbox WHERE id = :id") suspend fun inboxItem(id: String): InboxEntity?
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun insertInbox(items: List<InboxEntity>)
    @Query("UPDATE inbox SET senderName = :senderName, payloadJson = :payloadJson, status = :status, createdAt = :createdAt, expiresAt = :expiresAt WHERE id = :id")
    suspend fun updateInbox(id: String, senderName: String, payloadJson: String, status: String, createdAt: String, expiresAt: String)
    @Transaction suspend fun mergeInbox(item: InboxEntity) {
        insertInbox(listOf(item))
        updateInbox(item.id, item.senderName, item.payloadJson, item.status, item.createdAt, item.expiresAt)
    }
    @Query("UPDATE inbox SET status = :status WHERE id = :id") suspend fun updateInboxStatus(id: String, status: String)
    @Query("SELECT id FROM inbox WHERE notified = 0") suspend fun unnotifiedIds(): List<String>
    @Query("UPDATE inbox SET notified = 1 WHERE id IN (:ids)") suspend fun markNotified(ids: List<String>)

    @Query("SELECT * FROM outbox WHERE localId = :id") suspend fun outbox(id: String): OutboxEntity?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun upsertOutbox(item: OutboxEntity)
    @Query("UPDATE outbox SET transferId = :transferId, stage = :stage, error = :error WHERE localId = :id")
    suspend fun updateOutbox(id: String, transferId: String?, stage: String, error: String? = null)
}

@Dao
interface PlaybackEventDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(item: PlaybackEventEntity): Long

    @Query("SELECT * FROM playback_events WHERE syncState IN ('pending', 'in_flight') ORDER BY occurredAt, eventId LIMIT :limit")
    suspend fun pending(limit: Int = 100): List<PlaybackEventEntity>

    @Query("UPDATE playback_events SET syncState = 'synced', lastErrorCode = NULL WHERE eventId IN (:eventIds)")
    suspend fun markSynced(eventIds: List<String>)

    @Query("UPDATE playback_events SET syncState = :state, attemptCount = attemptCount + 1, lastErrorCode = :code WHERE eventId IN (:eventIds)")
    suspend fun markFailed(eventIds: List<String>, state: String, code: String?)

    @Query("SELECT COUNT(*) FROM playback_events WHERE syncState = 'pending'")
    suspend fun pendingCount(): Int

    @Query("SELECT COUNT(*) FROM playback_events WHERE syncState = 'dead_letter'")
    suspend fun deadLetterCount(): Int

    @Query("DELETE FROM playback_events WHERE syncState = 'synced' AND occurredAt < :before")
    suspend fun deleteSyncedBefore(before: String)
}

@Database(entities = [InboxEntity::class, OutboxEntity::class, PlaybackEventEntity::class], version = 3, exportSchema = true)
abstract class AppDatabase : RoomDatabase() {
    abstract fun transfers(): TransferDao
    abstract fun playbackEvents(): PlaybackEventDao
}
