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

    @Test fun pulseSerializesExactBatteryAndSteps() {
        val snapshot = PulseSnapshot(
            device = PulseDevice("online", 57, false),
            activity = PulseActivity(6_832),
            generatedAt = "2026-07-30T00:00:00Z",
            expiresAt = "2026-07-30T01:00:00Z",
        )
        val encoded = json.encodeToString(snapshot)
        assertTrue(encoded.contains("\"batteryPercent\":57"))
        assertTrue(encoded.contains("\"steps\":6832"))
        assertFalse(encoded.contains("batteryLevel"))
        assertFalse(encoded.contains("stepsBucket"))
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
