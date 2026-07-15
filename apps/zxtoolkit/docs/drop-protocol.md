# Drop protocol

认证请求同时携带 Bearer token 与 `X-Device-Id`。`POST /api/drops` 当前接受 text/url；`GET /api/inbox` 与 `/api/drops/recent` 返回 24 小时内内容；`POST /api/drops/:id/opened` 回传已打开。图片旧路由仍存在，但生产依赖暂不可用的私有 R2。
