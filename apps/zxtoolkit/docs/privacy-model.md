# Pulse privacy model

客户端 Provider 读取原始系统值，隐私规则将电量和步数转换为档位，用户在 `/pulse` 看到最终 JSON 后主动发布。Worker 只接受 schemaVersion 1 白名单，最长有效期 24 小时；当前开发 UI 使用 30 分钟。公开 API 不包含设备 ID、token、IP、系统版本或原始健康数据。

临时图片会话创建前必须通过 Turnstile。服务端可将来源 IP 发送给 Cloudflare Siteverify 并临时用作限流 key，但不会写入 Durable Object、R2 元数据或应用日志。Turnstile secret 只通过 Worker secret 注入。
