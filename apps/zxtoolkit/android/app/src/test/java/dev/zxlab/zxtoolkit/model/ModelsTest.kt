package dev.zxlab.zxtoolkit.model

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class ModelsTest {
    private val json = Json { classDiscriminator = "type" }

    @Test fun classifiesOnlyHttpUrls() {
        assertEquals(DropPayload.Url("https://zx-dx.xyz/path"), classifyText("https://zx-dx.xyz/path"))
        assertTrue(classifyText("http://localhost/a") is DropPayload.Url)
        assertTrue(classifyText("ftp://example.com") is DropPayload.Text)
        assertTrue(classifyText("hello.example.com") is DropPayload.Text)
    }

    @Test fun normalizesInternationalHttpUrls() {
        assertEquals("https://example.com/%E6%B5%8B%E8%AF%95", normalizeHttpUrl(" https://example.com/测试 "))
        assertNull(normalizeHttpUrl("javascript:alert(1)"))
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

    @Test fun fileLimitMatchesCloudflareOneHundredMegabytes() {
        assertEquals(100_000_000L, MAX_FILE_BYTES)
        assertTrue(MAX_FILE_BYTES + 1 > MAX_FILE_BYTES)
    }
}
