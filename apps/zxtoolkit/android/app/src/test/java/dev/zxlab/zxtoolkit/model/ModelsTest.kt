package dev.zxlab.zxtoolkit.model

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class ModelsTest {
    private val json = Json { classDiscriminator = "type" }

    @Test fun classifiesOnlyHttpUrls() {
        assertTrue(classifyText("https://zx-dx.xyz/path") is DropPayload.Url)
        assertTrue(classifyText("http://localhost/a") is DropPayload.Url)
        assertTrue(classifyText("ftp://example.com") is DropPayload.Text)
        assertTrue(classifyText("hello.example.com") is DropPayload.Text)
    }

    @Test fun mapsBatteryBoundaries() {
        assertEquals("low", batteryBucket(24))
        assertEquals("medium", batteryBucket(25))
        assertEquals("medium", batteryBucket(59))
        assertEquals("high", batteryBucket(60))
    }

    @Test fun payloadUsesProtocolDiscriminator() {
        val encoded = json.encodeToString<DropPayload>(DropPayload.File("report.pdf", "application/pdf", 42))
        assertTrue(encoded.contains("\"type\":\"file\""))
        assertEquals(DropPayload.File("report.pdf", "application/pdf", 42), json.decodeFromString<DropPayload>(encoded))
    }

    @Test fun fileLimitIsExactlyTwentyMiB() {
        assertEquals(20L * 1024 * 1024, MAX_FILE_BYTES)
        assertTrue(MAX_FILE_BYTES + 1 > MAX_FILE_BYTES)
    }
}
