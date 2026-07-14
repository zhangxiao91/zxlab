# zxdrop

zxdrop 是 zxlab 的个人跨设备投递工具。核心入口是常驻 macOS 菜单栏的 Tauri 2 应用；手机、iPad、Windows 或临时电脑通过移动端优先的 Web 收件箱接收内容。

当前最短闭环是：Mac 首次生成一次性二维码，手机确认长期配对；以后在 Mac 上复制文字或链接，主动点击“发送剪贴板”，手机收件箱会在数秒内出现内容。

## 当前 MVP

### macOS 菜单栏应用

- Tauri 2 + React + Vite，启动后不显示普通主窗口
- 菜单栏图标、点击切换弹窗、失焦自动隐藏、关闭后继续运行
- 首次配对二维码，配对成功后记住长期设备凭证和默认目标
- 仅在用户点击时读取当前剪贴板
- 识别纯文字与 `http/https` URL，支持空内容、失败和重试提示
- 默认目标设备选择、最近四条投递记录、送达/打开状态
- 打开 Web 收件箱、解除当前设备
- 文件选择和拖放区域保留 UI，不会伪装为已实现

### Web 收件箱

- `/pair/:code`：命名设备并确认一次性配对
- `/inbox`：显示最近收到的文字和链接
- 文字一键复制，链接点击打开并回传“已打开”状态
- 每 3 秒刷新；页面从后台恢复时立即刷新
- 手机浏览器优先布局、未配对/空状态/错误状态
- 原有短期图片会话、粘贴截图、WebSocket、R2 传输页面保持可用

### Cloudflare 服务端

- Worker 提供统一 JSON API 与统一错误结构
- `PairingSession` Durable Object 管理 10 分钟、一次性配对会话
- `DeviceMailbox` Durable Object 保存设备关系、临时收件箱和发送记录
- 长期凭证只存 SHA-256 摘要，请求同时校验设备 ID 与 Bearer token
- 文字和链接 24 小时过期，Durable Object alarm 负责清理
- 原有 `TransferSession` Durable Object + WebSocket + 私有 R2 图片链路未移除

## 当前不支持

- 自动剪贴板同步、截图目录监听或后台持续读取剪贴板
- 完整文件投递、图片剪贴板投递（菜单栏端）
- Finder 扩展、Share Extension、WebRTC、局域网发现
- iOS/Windows 原生客户端、账号系统、团队空间
- 云盘目录、永久内容、永久历史记录
- macOS Keychain；当前通过抽象存储接口使用 Tauri Store，后续迁移
- 浏览器端端到端加密

当前 MVP 使用传输层加密和短期访问控制，浏览器端端到端加密将在下一阶段完成。

## 目录

```text
apps/zxdrop/
├── desktop/
│   ├── src/                  菜单栏弹窗 React UI 与平台适配
│   └── src-tauri/            Tauri 2、系统托盘、窗口和权限配置
├── shared/                   Web、Desktop、Worker 共用类型和 payload 校验
├── src/
│   ├── PairApp.tsx           Web 配对页
│   ├── InboxApp.tsx          Web 收件箱
│   └── lib/                  API client、原图片 MVP 能力
├── worker/
│   ├── src/pairing.ts        一次性配对 Durable Object
│   ├── src/device-mailbox.ts 长期设备与临时投递 Durable Object
│   ├── src/session.ts        原图片会话 Durable Object / WebSocket
│   └── wrangler.jsonc        Worker、Durable Objects、R2 配置
└── README.md
```

## 环境要求

- macOS 12 或更高版本
- Node.js 22.12 或更高版本
- Rust stable toolchain：`rustup`、`cargo`、`rustc`
- Xcode Command Line Tools
- Cloudflare 部署需要可用的 Workers、Durable Objects 和 R2 账户

## 本地开发

以下命令均从仓库根目录 `zxlab/` 执行，除非特别注明。

```bash
npm install
```

安装根站点、zxdrop Web、Worker 和 Tauri JavaScript 依赖。

```bash
cp apps/zxdrop/.env.example apps/zxdrop/.env.local
cp apps/zxdrop/worker/.dev.vars.example apps/zxdrop/worker/.dev.vars
npm run dev:all --workspace zxdrop
```

启动 Web `http://localhost:4173` 和本地 Worker `http://localhost:8787`。健康检查为 `http://localhost:8787/api/health`。

另开一个终端：

```bash
npm run dev:desktop --workspace zxdrop
```

先启动桌面 Vite，再以开发模式编译并运行 Tauri 菜单栏应用。应用没有 Dock 主窗口；从 macOS 菜单栏打开弹窗。退出请右键菜单栏图标并选择“退出 zxdrop”。

只预览桌面弹窗的 Web UI 时可运行：

```bash
npm run dev:desktop:web --workspace zxdrop
```

地址为 `http://localhost:4174`，此模式使用浏览器剪贴板和 localStorage 回退，不代表原生权限验证。

真实手机不能访问电脑的 `localhost`。局域网联调需让 4173 和 8787 可从手机访问，或使用 HTTPS tunnel，并同步修改 `VITE_API_BASE_URL`、`VITE_PUBLIC_APP_URL` 与 Worker `APP_ORIGIN`。

## 环境变量

前端 `.env.local`：

| 变量 | 示例 | 用途 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `http://localhost:8787` | Web 与 Desktop 调用的 Worker 地址 |
| `VITE_PUBLIC_APP_URL` | `http://localhost:4173` | 二维码与“打开收件箱”的 Web 地址 |

Worker `worker/.dev.vars`：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `APP_ORIGIN` | `http://localhost:4173` | 配对 URL 来源和允许的前端 Origin |
| `SESSION_TTL_SECONDS` | `600` | 原图片临时会话有效期 |
| `MAX_FILE_BYTES` | `20971520` | 原图片链路单文件上限 20 MB |

这些变量不是秘密。若以后加入服务端密钥，请使用 `wrangler secret put`，不要写入配置、前端代码或日志。

## Cloudflare 配置

### R2

原图片 MVP 仍依赖两个私有 bucket：

```bash
npx wrangler r2 bucket create zxdrop-files
npx wrangler r2 bucket create zxdrop-files-preview
```

不要为 bucket 开启公开 `r2.dev` 地址或公开自定义域名。文件只通过 Worker 的带授权路由读取。

### Durable Objects

`worker/wrangler.jsonc` 包含三个绑定：

- `SESSIONS` → `TransferSession`：10 分钟图片会话和 WebSocket
- `PAIRINGS` → `PairingSession`：10 分钟一次性配对
- `DEVICES` → `DeviceMailbox`：设备凭证、绑定关系、收件箱和最近投递

`v1` migration 保留 `TransferSession`，`v2` migration 新增 `PairingSession` 与 `DeviceMailbox`。生产环境首次部署会由 Wrangler 应用 migration。

## API

```text
POST   /api/pairing/sessions
GET    /api/pairing/sessions/:id
POST   /api/pairing/sessions/:id/confirm
GET    /api/devices
DELETE /api/devices/:id
POST   /api/drops
GET    /api/inbox
GET    /api/drops/recent
POST   /api/drops/:id/opened
```

设备 API 要求 `Authorization: Bearer <token>` 与 `X-Device-Id`。服务端不信任单独传入的设备 ID。错误统一为：

```json
{
  "error": {
    "code": "DEVICE_UNAUTHORIZED",
    "message": "设备凭证无效或已被吊销"
  }
}
```

## 检查与构建

从仓库根目录执行：

```bash
npm run lint --workspace zxdrop
npm run typecheck --workspace zxdrop
npm run test --workspace zxdrop
npm run build --workspace zxdrop
npm run build:desktop:web --workspace zxdrop
npx wrangler deploy --dry-run --config apps/zxdrop/worker/wrangler.jsonc
```

Rust 静态检查：

```bash
cd apps/zxdrop/desktop/src-tauri
cargo check
```

生成未签名的 macOS 开发包：

```bash
cd /path/to/zxlab
npm run build:desktop --workspace zxdrop
```

未配置 Apple Developer ID、notarization 和签名证书时，构建产物仅适合本机开发验证，不可直接作为正式公开安装包分发。

## 部署

部署 Worker：

```bash
cd apps/zxdrop
npm run types:worker
npx wrangler deploy --config worker/wrangler.jsonc
```

将生产 Worker 地址写入 `apps/zxdrop/.env.production`：

```dotenv
VITE_API_BASE_URL=https://zxdrop-api.<account-subdomain>.workers.dev
VITE_PUBLIC_APP_URL=https://zxdrop.pages.dev
```

构建并部署 Pages：

```bash
cd /path/to/zxlab
npm run build:zxdrop
npx wrangler pages deploy apps/zxdrop/dist --project-name zxdrop --branch beta
```

生产桌面包需在构建时注入同一组 `VITE_*` 地址。正式分发前还需配置 Apple Developer ID 签名、Hardened Runtime 和 notarization。

## 生命周期与状态

- 配对码 10 分钟有效且只能确认一次。
- 配对成功后设备关系长期存在，直到任一设备解除绑定。
- 文字和链接投递保留 24 小时，之后由 Durable Object alarm 清理。
- 菜单栏最近记录最多展示 4 条，服务端最多保留最近 50 条未过期记录。
- 原图片文件仍为 10 分钟临时对象；领取确认或过期后从 R2 删除。
- 不提供永久历史、公开分享链接或云盘式存储。

## 安全和隐私

- zxdrop 不会自动读取或同步剪贴板；只有用户点击“发送剪贴板”才调用系统 API。
- 生产流量使用 Cloudflare HTTPS/WSS。
- 配对 claim token 和长期设备 token 都由 Web Crypto 生成 32 字节随机值。
- 服务端只保存 token 的 SHA-256 摘要，并使用常量时间比较。
- 配对二维码只包含一次性配对 ID，不包含长期设备 token。
- 每个设备请求都校验设备 ID、token 和配对关系。
- 日志不输出完整 token、Authorization、正文内容或完整请求 URL。
- Tauri 权限仅允许读取剪贴板文字、打开 URL、Store 与 autostart 插件基础能力。
- 当前本地凭证由 Tauri Store 保存，存储接口已隔离；迁移 macOS Keychain 是下一阶段安全项。

## 浏览器与平台限制

- Web Clipboard API 一般要求 HTTPS 或 localhost，且浏览器可能要求用户手势和额外授权。
- Web 收件箱使用轮询而不是推送，最迟约 3 秒显示新投递；切回前台会立即刷新。
- Safari 隐私清理、无痕模式或清除站点数据会删除 Web 设备凭证，需要重新配对。
- 当前 macOS 包未签名、未 notarize，其他 Mac 可能被 Gatekeeper 阻止。
- 原图片 Web Share 仍必须由用户点击触发；不支持文件分享时只能回退下载，网页不能直接指定微信好友。
- PWA、后台 WebSocket 和分享行为在 iOS 与 Android 上存在差异。

## 已知问题

- 菜单栏端本轮只发送纯文字和 HTTP(S) URL；文件按钮和拖放区尚未接通。
- 当前使用 3 秒轮询，未实现 SSE 或设备投递推送。
- Tauri Store 不是 macOS Keychain，设备 token 的系统级保护仍需加强。
- 开机启动插件已接入，但默认不主动开启，后续应在设置页由用户选择。
- 设备管理当前支持解除当前目标，尚无独立的完整管理页。
- MIME magic-byte、IP 级限流和更细滥用配额仍沿用旧 MVP 的已知限制。
- npm 上游依赖树报告审计问题；未运行可能带来破坏性升级的 `npm audit fix --force`。

## 下一阶段

1. 将 Tauri Store 凭证迁移到 macOS Keychain，并补充可见的开机启动设置。
2. 打通文件选择、拖放和菜单栏图片剪贴板投递，复用现有私有 R2 生命周期。
3. 以 SSE 或 Durable Object WebSocket 替代 3 秒收件箱轮询，并补充推送状态。
