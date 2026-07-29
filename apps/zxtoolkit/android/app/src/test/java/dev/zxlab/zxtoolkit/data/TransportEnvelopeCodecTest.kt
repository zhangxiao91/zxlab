package dev.zxlab.zxtoolkit.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Test

class TransportEnvelopeCodecTest {
    @Test fun encryptsPulseWithFreshAuthenticatedNonce() {
        val first = TransportEnvelopeCodec.encrypt("""{"device":{"presence":"online"}}""", "a".repeat(64))
        val second = TransportEnvelopeCodec.encrypt("""{"device":{"presence":"online"}}""", "a".repeat(64))
        assertFalse(first.ciphertext.contains("presence"))
        assertNotEquals(first.iv, second.iv)
        assertNotEquals(first.ciphertext, second.ciphertext)
    }
}
