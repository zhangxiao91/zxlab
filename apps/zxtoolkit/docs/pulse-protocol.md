# Pulse protocol

私有接口：`POST /api/pulse/snapshots`、`GET /api/pulse/snapshots/latest`、`GET /api/pulse/devices`。公开接口：`GET /api/public/status`，缓存 30 秒并允许 60 秒 stale-while-revalidate。快照仅支持 presence、batteryLevel、charging、stepsBucket、generatedAt、expiresAt 和 schemaVersion 1。
