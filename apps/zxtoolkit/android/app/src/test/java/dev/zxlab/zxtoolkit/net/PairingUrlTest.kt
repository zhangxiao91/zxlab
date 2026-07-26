package dev.zxlab.zxtoolkit.net

import org.junit.Assert.*
import org.junit.Test

class PairingUrlTest {
    private val id = "019f576c-7904-7101-85eb-f0374172a670"

    @Test fun acceptsConfiguredHttpsOrigin() {
        assertEquals(id, parsePairingUrl("https://zxtoolkit.pages.dev/pair/$id", "https://zxtoolkit.pages.dev"))
    }

    @Test fun rejectsOriginPathAndSchemeConfusion() {
        assertNull(parsePairingUrl("http://zxtoolkit.pages.dev/pair/$id", "https://zxtoolkit.pages.dev"))
        assertNull(parsePairingUrl("https://evil.example/pair/$id", "https://zxtoolkit.pages.dev"))
        assertNull(parsePairingUrl("https://zxtoolkit.pages.dev.evil.example/pair/$id", "https://zxtoolkit.pages.dev"))
        assertNull(parsePairingUrl("https://zxtoolkit.pages.dev/inbox/$id", "https://zxtoolkit.pages.dev"))
    }
}
