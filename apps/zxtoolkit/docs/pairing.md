# Pairing

`POST /api/pairing/sessions` 创建 10 分钟会话；二维码只含不可枚举 UUID。接收端 `POST .../confirm` 一次性确认，发起端用 claim token 轮询。`POST .../cancel` 可主动取消。长期 token 仅返回对应设备，服务端只保存 SHA-256 摘要。删除设备关系时目标 token 被吊销。

已认证 Mac 使用 `POST /api/pairing/sessions/add-device` 添加设备，请求必须同时携带 Bearer token 与 `X-Device-Id`。该模式复用现有 Mac 身份，只为新设备签发凭证；状态响应带 `mode: "add_device"` 且不会再次返回 Mac credential。设备关系保持以 Mac 为中心的星型结构，Android 与同一 Mac 下的 Web 设备不能直接互投。
Android 扫码后先调用 `GET /api/pairing/sessions/{id}/preview` 获取受限的 Mac 名称、模式和到期时间，向用户展示双方名称并确认；preview 不返回 claim token、credential 或设备 ID，已确认/取消/过期后返回 `410 PAIRING_UNAVAILABLE`。

设备可使用自己的 credential 调用 `DELETE /api/devices/{自己的 deviceId}` 自我解除。服务端吊销该 credential 并撤销全部 link，不会吊销配对的 Mac；Mac 删除其他设备仍沿用原有目标吊销语义。
