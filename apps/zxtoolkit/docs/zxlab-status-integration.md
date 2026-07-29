# zxlab Status integration

设置 `PUBLIC_STATUS_PROVIDER=zxtoolkit` 和 `PUBLIC_STATUS_API_BASE_URL=<Worker origin>`。Runtime 通过 zxtoolkit Service Binding 的 `/internal/runtime/health` 获取设备 presence、步数档位、当前/最近网易云播放和当日粗粒度统计，再写入 Runtime 自己的采样库。zxlab `/status` 只读取 Runtime 的公开投影，不调用设备私有接口。生产 Worker 的 `ZXLAB_ORIGIN` 应设置为实际 zxlab Origin，公开结果过期时返回 unavailable，不使用模拟数据替代。
