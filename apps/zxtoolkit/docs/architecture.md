# Architecture

Web 与 macOS 共享 `shared/` 类型和 API client。Worker 负责认证、Turnstile 校验、限流、实际字节检查与路由；`DeviceMailbox` 以设备 ID 分片保存哈希 token、配对关系、Drop 和设备自己的 Pulse；`PulseHub` 只聚合已脱敏的公开快照。`UploadQuota` 按 UTC 日期分片，强一致维护当日上传次数与字节配额。R2 仅服务旧图片链路，不参与文字、URL 或 Pulse。

模块边界：Drop 只处理内容与状态；Pulse 只处理公开快照；系统采集必须在客户端 Provider 内完成，上传前先经过隐私规则。
