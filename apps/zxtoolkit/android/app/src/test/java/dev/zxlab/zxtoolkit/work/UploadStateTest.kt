package dev.zxlab.zxtoolkit.work

import org.junit.Assert.assertEquals
import org.junit.Test

class UploadStateTest {
    @Test fun resumesPendingAndRecreatesExpiredTransfers() {
        assertEquals(UploadDecision.CREATE, uploadDecision(null, "queued"))
        assertEquals(UploadDecision.RESUME, uploadDecision("drop-1", "created"))
        assertEquals(UploadDecision.RECREATE, uploadDecision("drop-1", "created", 409))
        assertEquals(UploadDecision.RECREATE, uploadDecision("drop-1", "created", 410))
        assertEquals(UploadDecision.COMPLETE, uploadDecision("drop-1", "sent"))
        assertEquals(UploadDecision.STOP, uploadDecision("drop-1", "failed"))
    }
}
