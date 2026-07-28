# Drop protocol

认证请求同时携带 Bearer token 与 `X-Device-Id`。`POST /api/drops` 接受 `text`、`url`、`image` 与 `file`；图片和普通文件随后通过 `POST /api/transfers/:id/content` 上传。单个二进制内容最大 100 MB（100,000,000 字节）。`GET /api/inbox` 支持游标分页，`POST /api/inbox/events/ticket` 创建一次性 WebSocket ticket，`GET /api/inbox/events` 接收实时投递通知。

图片由 `GET /api/transfers/:id/download` 读取，客户端完成预览、分享或下载后通过 `PATCH /api/transfers/:id/status` 标记 opened 或 claimed。状态只能按 `pending → delivered → opened/claimed` 前进，并发重复领取不会倒退状态。claimed 后 R2 对象立即删除。

Android 前台保持 WebSocket，后台由 WorkManager 最快每 15 分钟补拉，因此后台通知不承诺实时。普通文件不得在刷新收件箱时自动下载；只有用户预览、分享或保存时才读取二进制内容。

Drop 默认 24 小时过期。定时任务每 15 分钟删除过期图片，过期或已领取的 D1 记录在额外 7 天后清理。旧的 10 分钟图片会话路由继续保留以兼容现有链接。
