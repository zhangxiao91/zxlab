# Pulse protocol

私有接口：`POST /api/pulse/snapshots`、`GET /api/pulse/snapshots/latest`、`GET /api/pulse/devices`。公开接口：`GET /api/public/status`，缓存 30 秒并允许 60 秒 stale-while-revalidate。新版快照支持 presence、batteryPercent、charging、steps、generatedAt、expiresAt 和 schemaVersion 1。校验器在升级窗口内继续接受旧版 batteryLevel 与 stepsBucket，但新版 Android、Web、Runtime 和 Status 均优先使用精确值。

发布请求不再发送明文 JSON。客户端使用 `SHA-256("zxtoolkit-pulse-v1\0" + deviceToken)` 派生 AES-256-GCM key，每次生成 96-bit 随机 nonce，并将固定 context 作为 AAD。Worker 先完成设备认证，再用当前请求中的 token 解密；D1 仍只保存 token hash，服务端不持久化派生 key。

精确电量限定为 0–100 的整数，今日步数限定为 0–500000 的整数。服务端仍会重建白名单对象，设备 ID、通知内容、应用列表和其他 Health Connect 数据不会进入公开投影。
