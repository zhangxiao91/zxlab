# zxlab Status integration

设置 `PUBLIC_STATUS_PROVIDER=zxtoolkit` 和 `PUBLIC_STATUS_API_BASE_URL=<Worker origin>`。zxlab 的 provider 只调用 `/api/public/status`，将公开设备 presence 映射为 Status 设备状态；它不会调用设备私有接口。生产 Worker 的 `ZXLAB_ORIGIN` 应设置为实际 zxlab Origin，公开结果过期时返回 `stale: true` 和空设备数组。
