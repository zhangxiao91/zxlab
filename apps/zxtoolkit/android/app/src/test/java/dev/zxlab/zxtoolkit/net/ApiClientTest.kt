package dev.zxlab.zxtoolkit.net

import dev.zxlab.zxtoolkit.model.*
import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

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

    @Test fun mapsStructuredErrors() = runTest {
        server.enqueue(MockResponse().setResponseCode(410).setHeader("content-type", "application/json").setBody("""{"error":{"code":"FILE_UNAVAILABLE","message":"文件已过期"}}"""))
        val error = runCatching { api.inbox(DeviceCredential(Device("android-1", "Pixel", "android", emptyList(), "now"), "secret")) }.exceptionOrNull() as ApiException
        assertEquals(410, error.status)
        assertEquals("FILE_UNAVAILABLE", error.code)
        assertEquals("文件已过期", error.message)
    }
}
