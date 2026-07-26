package dev.zxlab.zxtoolkit.data

import org.junit.Assert.*
import org.junit.Test
import java.util.Base64
import javax.crypto.AEADBadTagException
import javax.crypto.KeyGenerator

class AesGcmCodecTest {
    @Test fun encryptsDecryptsAndRejectsTampering() {
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val codec = AesGcmCodec(key)
        val encrypted = codec.encrypt("device-token-secret")
        assertFalse(encrypted.contains("device-token-secret"))
        assertEquals("device-token-secret", codec.decrypt(encrypted))

        val bytes = Base64.getDecoder().decode(encrypted)
        bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
        assertThrows(AEADBadTagException::class.java) { codec.decrypt(Base64.getEncoder().encodeToString(bytes)) }
    }
}
