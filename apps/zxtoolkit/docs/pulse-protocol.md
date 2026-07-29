# Pulse protocol

私有接口：`POST /api/pulse/snapshots`、`GET /api/pulse/snapshots/latest`、`GET /api/pulse/devices`。公开接口：`GET /api/public/status`，缓存 30 秒并允许 60 秒 stale-while-revalidate。快照仅支持 presence、batteryLevel、charging、stepsBucket、generatedAt、expiresAt 和 schemaVersion 1。

发布请求不再发送明文 JSON。客户端使用 `SHA-256("zxtoolkit-pulse-v1\0" + deviceToken)` 派生 AES-256-GCM key，每次生成 96-bit 随机 nonce，并将固定 context 作为 AAD。Worker 先完成设备认证，再用当前请求中的 token 解密；D1 仍只保存 token hash，服务端不持久化派生 key。
