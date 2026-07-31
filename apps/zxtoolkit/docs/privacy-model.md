# Pulse privacy model

客户端 Provider 读取原始系统值，隐私规则将电量和步数转换为档位，用户在 `/pulse` 看到最终 JSON 后主动发布。Worker 只接受 schemaVersion 1 白名单，最长有效期 24 小时；当前开发 UI 使用 30 分钟。公开 API 不包含设备 ID、token、IP、系统版本或原始健康数据。

临时图片会话创建前必须通过 Turnstile。服务端可将来源 IP 发送给 Cloudflare Siteverify 并临时用作限流 key，但不会写入 Durable Object、R2 元数据或应用日志。Turnstile secret 只通过 Worker secret 注入。

已绑定设备的文字、链接和图片元数据默认 24 小时有效。图片二进制领取后立即删除，未领取图片在过期清理或 R2 一天生命周期兜底时删除；过期/已领取元数据额外保留不超过 7 天用于状态一致性后清理。日志不输出设备 token、文字、URL 或文件内容。

Android 的 Health Connect 集成声明 `READ_STEPS`，并在设备支持时请求 `READ_HEALTH_DATA_IN_BACKGROUND`。用户点击首页步数卡片后才会看到系统权限页；应用按本地时区对当天 `StepsRecord.COUNT_TOTAL` 做聚合。部分 vivo 系统不会把 vivo 健康步数写入 Health Connect，因此标准聚合为空时，应用会读取系统公开的 `vivo_settings_realtime_steps` 当日值；该兼容层不访问 vivo 健康私有数据库，也不会在其他品牌启用。启用 Pulse 后，精确步数只作为 AES-256-GCM 加密快照的一部分上传，不写入 Room、DataStore 或日志，也不会读取其他健康数据。权限被拒绝、撤销或 Health Connect 不可用时，其他设备传输和日报功能不受影响。

今日日报不在 Android 端直连 Signal。手机使用已有设备凭证请求 zxtoolkit Worker，Worker 验证设备后通过 Cloudflare `SIGNAL` Service Binding 读取指定日期的公开日报。Android 不接触 Signal 管理凭证，zxtoolkit Worker 也不缓存日报正文。
