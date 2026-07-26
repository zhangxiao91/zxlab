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

@Dao
interface TransferDao {
    @Query("SELECT * FROM inbox ORDER BY createdAt DESC") fun inbox(): Flow<List<InboxEntity>>
    @Query("SELECT * FROM inbox WHERE id = :id") suspend fun inboxItem(id: String): InboxEntity?
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun insertInbox(items: List<InboxEntity>)
    @Query("UPDATE inbox SET senderName = :senderName, payloadJson = :payloadJson, status = :status, createdAt = :createdAt, expiresAt = :expiresAt WHERE id = :id")
    suspend fun updateInbox(id: String, senderName: String, payloadJson: String, status: String, createdAt: String, expiresAt: String)
    @Query("UPDATE inbox SET status = :status WHERE id = :id") suspend fun updateInboxStatus(id: String, status: String)
    @Query("SELECT id FROM inbox WHERE notified = 0") suspend fun unnotifiedIds(): List<String>
    @Query("UPDATE inbox SET notified = 1 WHERE id IN (:ids)") suspend fun markNotified(ids: List<String>)

    @Query("SELECT * FROM outbox WHERE localId = :id") suspend fun outbox(id: String): OutboxEntity?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun upsertOutbox(item: OutboxEntity)
    @Query("UPDATE outbox SET transferId = :transferId, stage = :stage, error = :error WHERE localId = :id")
    suspend fun updateOutbox(id: String, transferId: String?, stage: String, error: String? = null)
}

@Database(entities = [InboxEntity::class, OutboxEntity::class], version = 1, exportSchema = true)
abstract class AppDatabase : RoomDatabase() {
    abstract fun transfers(): TransferDao
}
