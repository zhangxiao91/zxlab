# zxdrop

zxdrop 是 zxlab 的轻量跨设备临时图片传输工具。电脑创建 10 分钟会话，手机扫码后实时连接；电脑粘贴或选择图片，手机收到后即可预览、调用系统分享面板或下载。

## 当前 MVP

- Ctrl/Cmd + V 直接读取 `ClipboardEvent` 中的截图
- 拖放或选择 PNG、JPEG、WebP、GIF 图片
- 单文件最大 20 MB
- 电脑端预览、上传进度、失败重试和发送结果
- 短期 `sessionId` 与 256-bit 随机 token
- 二维码中的 token 仅位于 URL fragment，不进入普通页面请求或 referrer
- 手机端 WebSocket 实时等待、自动下载与图片预览
- WebSocket 指数退避重连，页面恢复前台时主动重连
- Web Share API 使用 `File` 分享；不支持时回退下载
- 文件领取确认或会话过期后删除 R2 对象
- 发送端未过期会话可在刷新后恢复
- PWA manifest、Service Worker 和本地 IndexedDB 传输记录

## 当前不支持

- 用户账号、长期设备配对或多设备管理
- 多人房间、文件夹或批量传输
- WebRTC、Tauri、Electron、浏览器扩展或原生 App
- 永久文件、永久历史记录或公开文件链接
- 浏览器端端到端加密

当前 MVP 使用传输层加密和短期访问控制，浏览器端端到端加密将在下一阶段完成。

## 目录

```text
apps/zxdrop/
├── src/                    React/PWA 前端
│   └── lib/                API、session、IndexedDB、文件能力
├── worker/
│   ├── src/index.ts        Worker 路由、R2 上传下载和校验
│   ├── src/session.ts      Durable Object 与 WebSocket
│   ├── src/protocol.ts     消息协议和状态机
│   ├── wrangler.jsonc      Worker、R2、DO 配置
│   └── .dev.vars.example   Worker 本地变量示例
├── .env.example            Vite 环境变量示例
└── vite.config.ts          PWA 构建配置
```

## 本地开发

要求 Node.js 22.12 或更高版本。

```bash
git clone https://github.com/zhangxiao91/zxlab.git
cd zxlab
npm install
cp apps/zxdrop/.env.example apps/zxdrop/.env.local
cp apps/zxdrop/worker/.dev.vars.example apps/zxdrop/worker/.dev.vars
npm run dev:all --workspace zxdrop
```

- Web：`http://localhost:4173`
- Worker API：`http://localhost:8787`
- 健康检查：`http://localhost:8787/api/health`

手机无法直接访问电脑的 `localhost`。真实手机本地验收需要给 Web 和 Worker 提供同一局域网可访问地址，或使用 HTTPS tunnel，并相应修改 `VITE_PUBLIC_APP_URL`、`VITE_API_BASE_URL` 与 `APP_ORIGIN`。

## 检查命令

```bash
npm run lint --workspace zxdrop
npm run typecheck --workspace zxdrop
npm test --workspace zxdrop
npm run build:zxdrop
npx wrangler deploy --dry-run --config apps/zxdrop/worker/wrangler.jsonc
```

测试覆盖 session 创建基础、过期、token 摘要校验、文件大小、MIME 类型、状态流转、WebSocket 消息解析、上传失败文案、Web Share 回退和过期对象清理判断。

## Cloudflare 配置

### R2

创建生产和预览 bucket：

```bash
npx wrangler r2 bucket create zxdrop-files
npx wrangler r2 bucket create zxdrop-files-preview
```

Bucket 不应绑定公开自定义域名，也不应开启公开 `r2.dev` 访问。文件只通过带短期 token 的 Worker 路由读取。

### Durable Object

`worker/wrangler.jsonc` 将 `SESSIONS` 绑定到 `TransferSession`。每个 session 使用 `getByName(sessionId)` 路由到独立的 SQLite-backed Durable Object。`v1` migration 使用 `new_sqlite_classes`。

Durable Object 保存：

- token 的 SHA-256 摘要
- 会话创建和过期时间
- 当前传输元数据与状态
- 会话级上传次数

它不保存 token 明文或文件内容。WebSocket 使用 Hibernation API，连接角色通过 attachment 在休眠后恢复。

### 环境变量

前端：

| 变量 | 说明 |
| --- | --- |
| `VITE_API_BASE_URL` | Worker HTTPS 地址 |
| `VITE_PUBLIC_APP_URL` | 二维码指向的公开 Pages 地址 |

Worker：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_ORIGIN` | `https://zxdrop.pages.dev` | 允许的生产前端 Origin |
| `SESSION_TTL_SECONDS` | `600` | 会话有效时间，代码限制在 60–600 秒 |
| `MAX_FILE_BYTES` | `20971520` | 单文件上限 |

这些值不是秘密。未来引入服务端密钥时必须使用 `wrangler secret put`，不得写入配置或日志。

## 部署

先生成绑定类型并部署 Worker：

```bash
cd apps/zxdrop
npm run types:worker
npx wrangler deploy --config worker/wrangler.jsonc
```

将实际 Worker 地址写入 `apps/zxdrop/.env.production`：

```dotenv
VITE_API_BASE_URL=https://zxdrop-api.<account-subdomain>.workers.dev
VITE_PUBLIC_APP_URL=https://zxdrop.pages.dev
```

构建并部署 Pages：

```bash
cd ../..
npm run build:zxdrop
npx wrangler pages deploy apps/zxdrop/dist --project-name zxdrop --branch beta
```

自定义域名部署后，同时更新 `VITE_PUBLIC_APP_URL` 与 Worker 的 `APP_ORIGIN`。

## 文件生命周期

1. 电脑创建 session，Worker 生成随机 token，DO 仅保存摘要。
2. 手机通过二维码 fragment 取得 token，并连接对应 session WebSocket。
3. Worker 校验 token、接收流式请求并写入私有 R2。
4. DO 广播 `transfer_ready`；手机携带 token 下载图片。
5. 手机成功取得 Blob 后发送领取确认，Worker 删除 R2 对象。
6. 未领取文件由 DO alarm 在会话到期时删除。
7. 手机内存中的 Blob 可继续预览、分享或下载，刷新后不会从服务端恢复已领取文件。

## 安全模型

- 生产环境通过 Cloudflare HTTPS/WSS 传输。
- session token 使用 Web Crypto 生成 32 字节随机值。
- 服务端只保存 SHA-256 token 摘要，并进行常量时间比较。
- session、token、不可预测 object key 和 10 分钟有效期共同控制访问。
- R2 不公开；未授权请求不能读取或删除文件。
- Worker 不解析文件内容，不记录 token、文件内容或完整请求 URL。
- 仅允许四种图片 MIME，并同时校验 `Content-Length` 和 20 MB 上限。
- 每个 session 最多接受 20 次上传，降低被滥用风险。

当前服务端能够在传输期间读取图片明文，因此这不是端到端加密。下一阶段应在浏览器内使用 AES-256-GCM 加密文件，并使用接收端临时公钥封装文件密钥。

## WebSocket 协议

服务端消息包括：

- `connected`
- `peer_status`
- `transfer_ready`
- `transfer_claimed`
- `transfer_deleted`
- `session_expired`
- `error`

客户端发送 `ping` 心跳。浏览器断线后按指数退避重连，最大间隔 15 秒；页面从后台恢复时主动连接。

## 浏览器兼容性与限制

- 页面不能在后台持续监听系统剪贴板，用户需要切回 zxdrop 后按 Ctrl/Cmd + V。
- Clipboard、PWA、Web Share 和后台 WebSocket 在 iOS 与 Android 上存在差异。
- Web Share 必须由用户点击触发，且浏览器必须支持文件分享。
- 网页无法跳过系统分享面板，也不能直接指定微信好友。
- 不支持文件分享时，zxdrop 下载图片并提示用户保存后再分享到微信。
- PWA Service Worker、Clipboard 和 Web Share 通常要求 HTTPS 或 localhost 安全上下文。

## 已知问题

- 已领取文件立即从 R2 删除，因此手机刷新页面后不能重新下载同一文件。
- 当前一次 session 只保留一个活动传输。
- MIME 校验依赖浏览器提供的 `Content-Type`，尚未检查文件 magic bytes。
- 限流目前为 session 级 20 次上传，尚未加入 IP/账户级日流量配额。
- npm 上游依赖树当前报告 5 个审计问题；未使用可能引入破坏性升级的 `npm audit fix --force`。

## 下一阶段

1. 浏览器端 AES-256-GCM 文件加密与临时公钥密钥封装。
2. Magic-byte 校验、IP 级限流与更完整的滥用保护。
3. iOS Safari、Android Chrome 的 PWA/分享/后台恢复真机回归测试。
