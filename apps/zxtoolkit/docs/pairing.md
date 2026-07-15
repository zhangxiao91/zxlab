# Pairing

`POST /api/pairing/sessions` 创建 10 分钟会话；二维码只含不可枚举 UUID。接收端 `POST .../confirm` 一次性确认，发起端用 claim token 轮询。`POST .../cancel` 可主动取消。长期 token 仅返回对应设备，服务端只保存 SHA-256 摘要。删除设备关系时目标 token 被吊销。
