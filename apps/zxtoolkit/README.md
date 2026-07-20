# zxtoolkit

zxtoolkit 是连接 Mac 与其他个人设备的轻量工具集，目前包含两个模块：

- Drop：已绑定设备之间投递文字、链接与剪贴板图片；旧的 10 分钟扫码图片会话继续兼容。
- Pulse：设备本地生成脱敏公开快照，服务端校验、短期保存并向 zxlab Status 输出稳定公开 API。

## 当前可运行闭环

Mac 菜单栏复制文字、URL 或图片 → 点击“发送剪贴板” → 移动 Web 收件箱实时收到内容 → 复制、打开、分享或下载。

已配对移动 Web/PWA 选择开发态电量与步数档位 → 预览公开 JSON → 发布 → `/pulse/preview` 与 `/api/public/status` 读取。当前 Pulse 是明确标记的 mock provider，不代表 Android 系统真实数据。

## 结构

```text
apps/zxtoolkit/
├── desktop/        Tauri 2 macOS 菜单栏应用
├── shared/         设备、Drop、Pulse 共享类型与运行时校验
├── src/            Web 收件箱、配对、Pulse 发布与公开预览
├── worker/         Worker、Durable Objects、兼容的 R2 图片路由
└── docs/           当前协议、隐私与接入文档
```

Android 原生工程尚未创建。当前 Android 入口是移动 Web/PWA，Pulse provider 与 UI/业务层已经分离为公共快照 schema；后续接入 Kotlin/Health Connect 时替换采集层即可。

## 本地开发

在仓库根目录：

```bash
npm install
cp apps/zxtoolkit/.env.example apps/zxtoolkit/.env.local
cp apps/zxtoolkit/worker/.dev.vars.example apps/zxtoolkit/worker/.dev.vars
npm run dev:all --workspace zxtoolkit
```

Web 为 `http://localhost:4173`，Worker 为 `http://localhost:8787`。另开终端启动 macOS：

```bash
npm run dev:desktop --workspace zxtoolkit
```

主要路由：`/pair/:code`、`/inbox`、`/pulse`、`/pulse/preview`。手机不能访问 Mac 的 localhost，真机联调需要局域网地址或 HTTPS tunnel。

首次本地启动前应用 D1 migration：

```bash
cd apps/zxtoolkit
npx wrangler d1 migrations apply zxtoolkit --local --config worker/wrangler.jsonc
```

## 环境变量

```dotenv
VITE_ZXTOOLKIT_API_BASE_URL=http://localhost:8787
VITE_ZXTOOLKIT_PUBLIC_URL=http://localhost:4173
VITE_TURNSTILE_SITE_KEY=1x00000000000000000000AA
```

本地示例使用 Cloudflare 官方 Turnstile 测试密钥。生产 widget 的公开配置记录在 `.env.production.example`；部署环境使用对应变量，secret 通过交互式命令设置，不能写入仓库：

```bash
cd apps/zxtoolkit
npx wrangler secret put TURNSTILE_SECRET_KEY --config worker/wrangler.jsonc
```

Worker 还使用 `APP_ORIGIN`、`ZXLAB_ORIGIN`、`ENVIRONMENT`、`TURNSTILE_EXPECTED_HOSTNAMES`、`SESSION_TTL_SECONDS`、`PAIRING_TTL_SECONDS`、`DROP_TTL_SECONDS`、`DROP_RECORD_RETENTION_SECONDS`、`DAILY_DROP_LIMIT`、`MAX_FILE_BYTES`、`DAILY_UPLOAD_LIMIT` 与 `DAILY_UPLOAD_BYTES`。默认每日最多 200 次内容投递、500 次上传、总计 2 GiB；单文件硬上限仍为 20 MiB。旧 `VITE_API_BASE_URL` 与 `VITE_PUBLIC_APP_URL` 暂时作为兼容输入。

生产 API 使用自定义域名 `https://zxtoolkit-api.zx-dx.xyz`，避免客户端依赖 `workers.dev`。

zxlab Status 设置：

```dotenv
PUBLIC_STATUS_PROVIDER=zxtoolkit
PUBLIC_STATUS_API_BASE_URL=http://localhost:8787
```

## 检查和构建

```bash
npm run lint --workspace zxtoolkit
npm run typecheck --workspace zxtoolkit
npm run test --workspace zxtoolkit
npm run build --workspace zxtoolkit
npm run build:desktop --workspace zxtoolkit
npm run smoke:local --workspace zxtoolkit
npx wrangler deploy --dry-run --config apps/zxtoolkit/worker/wrangler.jsonc
```

`smoke:local` 会实际完成配对、文字投递、图片上传与下载、领取删除、凭证轮换及实时连接票据签发。

## Cloudflare 配置与部署

正式环境使用 Pages、Workers、D1、R2 与 Durable Objects。D1 保存设备、凭证哈希、配对关系、投递元数据和状态事件；R2 只保存短期图片；Durable Objects 负责配对协调、收件箱 WebSocket 和上传配额。

新 Cloudflare 账号需要依次执行：

```bash
cd apps/zxtoolkit
npx wrangler d1 create zxtoolkit --config worker/wrangler.jsonc
npx wrangler d1 migrations apply zxtoolkit --remote --config worker/wrangler.jsonc
npm run r2:lifecycle:add
npx wrangler deploy --config worker/wrangler.jsonc
npm run build
npx wrangler pages deploy dist --project-name zxtoolkit --branch beta
```

`worker/wrangler.jsonc` 中的 D1 `database_id` 必须替换为新账号实际返回值。Turnstile secret 使用 `wrangler secret put`，不得写入配置。

## macOS Release、签名与 notarization

桌面端 Bundle Identifier 为 `dev.zxlab.zxtoolkit`，最低支持 macOS 12。Release 配置包含菜单栏 Accessory 模式、网络客户端 entitlement、Keychain 凭证存储、通知权限、`.app` 与 `.dmg` 打包目标。

复制 `desktop/.env.release.example` 中需要的变量到当前 shell或 CI Secret，然后运行：

```bash
cd apps/zxtoolkit
npm run release:macos
```

Tauri 使用 `APPLE_SIGNING_IDENTITY` 和 `APPLE_TEAM_ID` 签名，并通过 App Store Connect API Key，或 `APPLE_ID` + app-specific password 提交 notarization。仓库不包含证书和 Apple 凭证；没有真实 Developer ID 证书时只能验证本地构建，不能声称 notarization 成功。

长期设备 token 在 macOS 上只写入 Keychain。Tauri Store 仅保存设备公开元数据和默认目标 ID；旧版本 Store 中的明文 token 会在首次读取时迁入 Keychain 并从 JSON 删除。

## 浏览器兼容性

- 收件箱支持当前版本的 Safari、Chrome、Edge 与主流移动浏览器。
- WebSocket 失败时保留 30 秒游标轮询兜底；页面回到前台会立即补拉。
- Web Share 必须同时支持文件分享；不支持时自动下载，并提示保存后再分享到其他应用。
- Web Clipboard 写入需要 HTTPS 或浏览器授权，失败时可长按内容手动复制。
- PWA 可以添加到主屏幕，但 iOS 可能暂停后台连接，恢复前台后会补齐遗漏投递。

## 安全模型

- 配对码为短期、一次性高熵标识，并对创建接口限流。
- 长期设备 token 只在客户端返回一次；服务端 D1 仅保存 SHA-256 摘要，支持轮换和吊销。
- 设备只能读取发给自己的投递，图片下载必须携带目标设备凭证，R2 不公开。
- 图片限制 PNG、JPEG、WebP、GIF 和 20 MiB，并同时检查 MIME、实际字节数和文件签名。
- WebSocket 使用 60 秒一次性票据，不把长期 token 放进 URL。
- CORS 仅允许配置的 Pages、zxlab、Tauri 和本地开发来源；日志不记录正文和完整 token。
- 当前版本依赖 HTTPS 传输加密与短期访问控制，浏览器端端到端加密仍属于下一阶段。

## R2 与费用保护

- 创建会话必须通过 Turnstile，并限制为每个来源每分钟 5 次。
- 每个会话每分钟最多上传 10 次、下载 60 次，且整个会话最多尝试上传 20 次。
- Worker 实际读取并计算上传字节，不信任 `Content-Length`；超过 20 MiB 会中止，图片 MIME 与文件签名必须匹配。
- UTC 每日配额由按日期分片的 `UploadQuota` Durable Object 强一致维护。
- 10 分钟过期与领取即删由会话负责；R2 一天生命周期规则作为异常兜底。
- 已绑定设备的 Drop 默认 24 小时过期；二进制图片领取后立即从 R2 删除，过期元数据在额外 7 天后由定时任务清理。

R2 生命周期已在正式 bucket 执行；新环境可用以下命令配置和复核：

```bash
cd apps/zxtoolkit
npm run r2:lifecycle:add
npm run r2:lifecycle:list
```

账户已创建 `$1`、`$5`、`$20` 三档预算提醒，发送到账户邮箱。提醒只发邮件，不会自动停用服务；真正的硬限制由应用配额执行。完整配置见 [费用与滥用防护](docs/cost-controls.md)。

## 数据与更名兼容

- Web 设备凭证从旧 localStorage key 自动迁移。
- 临时 session key 自动迁移；旧 IndexedDB 名称暂时保留以避免丢失历史。
- Tauri 首次启动会把旧 Bundle Application Support 中的设备 Store 复制到新 Bundle 目录。
- Worker 暂时保留旧内部 script 名、R2 bucket 名和 DO 类/迁移顺序，避免切断已有 token 与状态。用户界面、包名、应用名和 Bundle ID 已改为 zxtoolkit。

## 隐私模型

Pulse 默认只接收 presence、电量档位、充电状态、步数档位、生成时间、过期时间和 schemaVersion。服务端会重建白名单对象，任意额外字段不会进入公开响应；快照过期后不再显示。不会上传精确位置、通知、应用列表、精确健康数据或设备 ID。

## 当前限制

- Pulse 使用开发态模拟值；尚未接入 Android 电池 API 或 Health Connect。
- 文件/图片生产链路已部署；仍需用真实手机完成一次扫码、图片发送与分享的人工验收。
- 收件箱使用 WebSocket 实时通知，并保留 30 秒轮询兜底。
- macOS 包尚未 Developer ID 签名或 notarize。

## 路线图

1. Android Kotlin 壳、真实电量/充电 Provider 与可选 Health Connect 步数。
2. 增加完整设备管理与凭证轮换 UI，并验证 Keychain 升级迁移。
3. 增加费用与限流指标面板，并根据真实个人使用数据调整每日 500 次、2 GiB 的默认配额。
