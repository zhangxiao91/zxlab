# Architecture

Web 与 macOS 共享 `shared/` 类型和 API client。macOS 凭证 token 保存在 Keychain，Tauri Store 只保存非敏感设备元数据和默认目标设备。

Worker 负责认证、Turnstile 校验、限流、实际字节检查与路由。D1 是设备、凭证哈希、配对关系、投递记录和状态事件的持久化主库；`PairingSession` 负责一次性配对状态，`DeviceMailbox` 负责收件箱 WebSocket 与旧数据迁移，`PulseHub` 聚合已脱敏的公开快照。`UploadQuota` 按 UTC 日期分片，强一致维护当日上传次数与字节配额。

R2 暂存已绑定设备和旧会话的图片二进制，不公开暴露对象地址。Drop 只处理内容与状态；Pulse 只处理公开快照；系统采集必须在客户端 Provider 内完成，上传前先经过隐私规则。

Android 首页增加两个彼此隔离的读取链路：

- 日报：Android 携带设备凭证请求 `/api/briefings/today?date=YYYY-MM-DD`，zxtoolkit Worker 完成设备认证后通过 `SIGNAL` Service Binding 读取 Signal Worker。日报正文不写入 zxtoolkit D1。
- 步数：Android 在用户授权 `READ_STEPS` 后直接调用 Health Connect 的 aggregate API，以本地时区聚合当天 `StepsRecord.COUNT_TOTAL`。精确步数只保存在 Compose/ViewModel 内存状态，不上传到任何远端边界。
