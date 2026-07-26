package dev.zxlab.zxtoolkit.work

enum class UploadDecision { CREATE, RESUME, RECREATE, COMPLETE, STOP }

fun uploadDecision(transferId: String?, stage: String, serverStatus: Int? = null): UploadDecision = when {
    stage == "sent" -> UploadDecision.COMPLETE
    stage == "failed" -> UploadDecision.STOP
    transferId == null -> UploadDecision.CREATE
    serverStatus == 409 || serverStatus == 410 -> UploadDecision.RECREATE
    else -> UploadDecision.RESUME
}
