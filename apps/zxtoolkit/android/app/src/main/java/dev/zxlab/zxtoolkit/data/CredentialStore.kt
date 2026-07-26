package dev.zxlab.zxtoolkit.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.datastore.preferences.core.*
import androidx.datastore.preferences.preferencesDataStore
import dev.zxlab.zxtoolkit.model.DeviceCredential
import kotlinx.coroutines.flow.first
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

private val Context.secureDataStore by preferencesDataStore("secure_device")

class CredentialStore(private val context: Context, private val json: Json) {
    private val credentialKey = stringPreferencesKey("credential_ciphertext")
    private val defaultMacKey = stringPreferencesKey("default_mac")
    private val pulseKey = booleanPreferencesKey("pulse_enabled")

    suspend fun credential(): DeviceCredential? {
        val encoded = context.secureDataStore.data.first()[credentialKey] ?: return null
        return runCatching { json.decodeFromString<DeviceCredential>(decrypt(encoded)) }.getOrNull()
    }

    suspend fun saveCredential(value: DeviceCredential) {
        context.secureDataStore.edit { it[credentialKey] = encrypt(json.encodeToString(value)) }
    }

    suspend fun clear() = context.secureDataStore.edit {
        it.remove(credentialKey)
        it.remove(defaultMacKey)
    }

    suspend fun defaultMac(): String? = context.secureDataStore.data.first()[defaultMacKey]
    suspend fun setDefaultMac(id: String) = context.secureDataStore.edit { it[defaultMacKey] = id }
    suspend fun pulseEnabled(): Boolean = context.secureDataStore.data.first()[pulseKey] ?: false
    suspend fun setPulseEnabled(enabled: Boolean) = context.secureDataStore.edit { it[pulseKey] = enabled }

    private fun encrypt(value: String): String {
        return AesGcmCodec(key()).encrypt(value)
    }

    private fun decrypt(value: String): String {
        return AesGcmCodec(key()).decrypt(value)
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build())
            generateKey()
        }
    }

    companion object {
        private const val KEY_ALIAS = "zxtoolkit-device-token-v1"
    }
}
