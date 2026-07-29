package dev.zxlab.zxtoolkit.data

import dev.zxlab.zxtoolkit.model.EncryptedEnvelope
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object TransportEnvelopeCodec {
    private const val CONTEXT = "zxtoolkit-pulse-v1"

    fun encrypt(cleartext: String, deviceToken: String): EncryptedEnvelope {
        val key = MessageDigest.getInstance("SHA-256").digest("$CONTEXT\u0000$deviceToken".toByteArray())
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"))
        cipher.updateAAD(CONTEXT.toByteArray())
        return EncryptedEnvelope(
            iv = encode(cipher.iv),
            ciphertext = encode(cipher.doFinal(cleartext.toByteArray(Charsets.UTF_8))),
        )
    }

    private fun encode(value: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(value)
}
