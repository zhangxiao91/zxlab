# Cost and abuse controls

## 已在代码中强制执行

- 创建会话：Turnstile Siteverify 服务端校验；每来源每分钟 5 次。
- 上传：每会话每分钟 10 次、会话总计 20 次；单文件实际读取上限 20 MiB。
- 下载：每会话每分钟 60 次。
- 每日账户配额：默认 500 次、2 GiB，按 UTC 日期重置。
- 文件类型：只允许 PNG、JPEG、WebP、GIF，同时校验文件头签名。
- 清理：领取即删、10 分钟会话 alarm 删除、R2 一天生命周期兜底。

Rate Limiting binding 是边缘节点局部、最终一致的快速保护；每日配额由 Durable Object 强一致执行，不能用限流器代替计费配额。

## 生产配置

1. Turnstile managed widget `zxtoolkit-session` 已创建，生产 hostname 为 `zxtoolkit.pages.dev`；本地开发继续使用官方测试密钥。
2. 真实 sitekey 与 API 地址记录在 `.env.production.example`；实际 Pages 构建使用对应环境变量。
3. `TURNSTILE_SECRET_KEY` 已作为 `zxdrop-api` Worker secret 注入；轮换时在 `apps/zxtoolkit` 交互式执行 `npx wrangler secret put TURNSTILE_SECRET_KEY --config worker/wrangler.jsonc`。
4. `zxdrop-files` 已启用 `zxtoolkit-temp-expiry` 一天兜底生命周期；用 `npm run r2:lifecycle:list` 复核。
5. Cloudflare Billing 已创建 `$1`、`$5`、`$20` 三个 budget alert，收件人为账户邮箱；Billing 页面显示 3 个有效提醒。

生产客户端通过 `https://zxtoolkit-api.zx-dx.xyz` 访问 Worker；`workers.dev` 只保留为 Cloudflare 自动生成的后备入口。

预算提醒是通知，不是硬消费上限。真正阻断滥用的是 Turnstile、路径限流、会话上限、实际字节上限和每日 Durable Object 配额。
