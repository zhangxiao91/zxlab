package dev.zxlab.zxtoolkit.net

import dev.zxlab.zxtoolkit.model.*
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.nio.file.Files

class ApiClientTest {
    private lateinit var server: MockWebServer
    private lateinit var api: ApiClient
    private val deviceJson = """{"id":"android-1","name":"Pixel","platform":"android","capabilities":["drop.send","drop.receive"],"createdAt":"2026-07-26T00:00:00Z","credentialVersion":1}"""

    @Before fun setup() { server = MockWebServer(); server.start(); api = ApiClient(server.url("/").toString().trimEnd('/')) }
    @After fun close() = server.shutdown()

    @Test fun confirmsAndroidPairing() = runTest {
        server.enqueue(MockResponse().setResponseCode(201).setHeader("content-type", "application/json").setBody("""{"credential":{"device":$deviceJson,"token":"secret"}}"""))
        val result = api.confirmPairing("pair-1", "Pixel")
        assertEquals("secret", result.token)
        val request = server.takeRequest()
        assertEquals("/api/pairing/sessions/pair-1/confirm", request.path)
        assertTrue(request.body.readUtf8().contains("\"platform\":\"android\""))
    }

    @Test fun loadsPairingPreviewAndMapsExpiry() = runTest {
        server.enqueue(MockResponse().setHeader("content-type", "application/json").setBody("""{"desktopName":"Studio Mac","mode":"add_device","expiresAt":"2026-07-26T01:00:00Z"}"""))
        assertEquals("Studio Mac", api.pairingPreview("pair-1").desktopName)
        server.enqueue(MockResponse().setResponseCode(410).setHeader("content-type", "application/json").setBody("""{"error":{"code":"PAIRING_UNAVAILABLE","message":"配对码已过期"}}"""))
        val error = runCatching { api.pairingPreview("pair-1") }.exceptionOrNull() as ApiException
        assertEquals(410, error.status)
        assertEquals("PAIRING_UNAVAILABLE", error.code)
    }

    @Test fun sendsDeviceAuthenticationHeaders() = runTest {
        server.enqueue(MockResponse().setHeader("content-type", "application/json").setBody("""{"device":$deviceJson,"pairedDevices":[]}"""))
        api.devices(DeviceCredential(Device("android-1", "Pixel", "android", emptyList(), "2026-07-26T00:00:00Z"), "secret"))
        val request = server.takeRequest()
        assertEquals("Bearer secret", request.getHeader("Authorization"))
        assertEquals("android-1", request.getHeader("X-Device-Id"))
    }

    @Test fun sendsStableIdempotencyKeyWhenCreatingATransfer() = runTest {
        server.enqueue(MockResponse().setResponseCode(201).setHeader("content-type", "application/json").setBody(
            """{"item":{"id":"drop-1","senderDeviceId":"android-1","senderDeviceName":"Pixel","receiverDeviceId":"mac-1","payload":{"type":"text","text":"hello"},"status":"delivered","createdAt":"2026-08-03T12:00:00Z","expiresAt":"2026-08-04T12:00:00Z"}}""",
        ))
        val credential = DeviceCredential(Device("android-1", "Pixel", "android", emptyList(), "now"), "secret")
        api.createDrop(credential, "mac-1", DropPayload.Text("hello"), "local-job-1")
        assertEquals("local-job-1", server.takeRequest().getHeader("X-Idempotency-Key"))
    }

    @Test fun mapsStructuredErrors() = runTest {
        server.enqueue(MockResponse().setResponseCode(410).setHeader("content-type", "application/json").setBody("""{"error":{"code":"FILE_UNAVAILABLE","message":"文件已过期"}}"""))
        val error = runCatching { api.inbox(DeviceCredential(Device("android-1", "Pixel", "android", emptyList(), "now"), "secret")) }.exceptionOrNull() as ApiException
        assertEquals(410, error.status)
        assertEquals("FILE_UNAVAILABLE", error.code)
        assertEquals("文件已过期", error.message)
    }

    @Test fun resumesPartialDownloadsWithAByteRange() = runTest {
        val folder = Files.createTempDirectory("zxtoolkit-download-test").toFile()
        val destination = folder.resolve("report.bin")
        folder.resolve("report.bin.part").writeBytes(byteArrayOf(1, 2, 3))
        server.enqueue(MockResponse().setResponseCode(206).setHeader("content-range", "bytes 3-4/5").setBody(okio.Buffer().write(byteArrayOf(4, 5))))
        val credential = DeviceCredential(Device("android-1", "Pixel", "android", emptyList(), "now"), "secret")

        api.download(credential, "drop-1", destination)

        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5), destination.readBytes())
        assertEquals("bytes=3-", server.takeRequest().getHeader("Range"))
        folder.deleteRecursively()
    }

    @Test fun parsesRealtimeDeliveryWithoutRefreshingTheWholeInbox() {
        val item = api.parseInboxEvent(
            """{"type":"drop_ready","item":{"id":"drop-live","senderDeviceId":"mac-1","senderDeviceName":"Mac","receiverDeviceId":"android-1","payload":{"type":"text","text":"hello"},"status":"delivered","createdAt":"2026-08-03T12:00:00Z","expiresAt":"2026-08-04T12:00:00Z"}}""",
        )
        assertEquals("drop-live", item?.id)
        assertEquals("hello", (item?.payload as DropPayload.Text).text)
        assertNull(api.parseInboxEvent("""{"type":"pong"}"""))
        assertNull(api.parseInboxEvent("not-json"))
    }

    @Test fun loadsTodayBriefingThroughDeviceBoundary() = runTest {
        server.enqueue(
            MockResponse().setHeader("content-type", "application/json").setBody(
                """{"id":"briefing-1","date":"2026-07-28","status":"ready","title":"今日信号","summary":"两条值得关注的变化","generatedAt":"2026-07-28T01:00:00Z","items":[{"id":"item-1","category":"zxlab","title":"zxtoolkit 更新","summary":"移动端能力扩展","whyItMatters":"主链路更完整","sources":[]}]}""",
            ),
        )
        val credential = DeviceCredential(Device("android-1", "Pixel", "android", emptyList(), "now"), "secret")
        val result = api.todayBriefing(credential, java.time.LocalDate.parse("2026-07-28"))
        assertEquals("今日信号", result.title)
        assertEquals("zxtoolkit 更新", result.items.single().title)
        val request = server.takeRequest()
        assertEquals("/api/briefings/today?date=2026-07-28", request.path)
        assertEquals("Bearer secret", request.getHeader("Authorization"))
    }

    @Test fun omitsNullPlaybackFieldsFromWirePayload() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(202).setHeader("content-type", "application/json").setBody(
                """{"batchId":"batch_12345678","accepted":["evt_12345678"],"duplicates":[],"rejected":[],"serverTime":"2026-07-30T12:00:00Z"}""",
            ),
        )
        val credential = DeviceCredential(Device("android-1", "Pixel", "android", emptyList(), "now"), "secret")
        api.publishPlaybackEvents(
            credential,
            PlaybackEventBatch(
                batchId = "batch_12345678",
                sentAt = "2026-07-30T12:00:00Z",
                events = listOf(
                    PlaybackEvent(
                        eventId = "evt_12345678",
                        sessionId = "ses_12345678",
                        eventType = "track_started",
                        fingerprint = "a".repeat(64),
                        track = PlaybackTrack(title = "Example Song"),
                        playback = PlaybackPosition(state = "playing"),
                        occurredAt = "2026-07-30T12:00:00Z",
                        elapsedRealtimeMs = 42,
                    ),
                ),
            ),
        )
        val body = server.takeRequest().body.readUtf8()
        assertFalse(body.contains("\"artworkUrl\""))
        assertFalse(body.contains("\"mediaId\""))
        assertFalse(body.contains("\"positionMs\""))
    }
}
