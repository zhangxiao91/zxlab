# ZX Signal Intelligence Loop v0

ZX Signal 现在由两个独立部分组成：Astro `/briefing` 保持现有阅读与批注界面，`apps/signal-worker` 负责模型调用、D1 持久化、批注回复与确认式 Memory。前后端核心契约统一来自 `packages/signal-schema`。

生产 Worker 在 UTC 23:30（北京时间 07:30）运行 Cron Trigger。scheduled handler 在 Worker 内部直接执行采集、编辑筛选和日报生成，不通过公开管理 API，也不依赖浏览器 Access cookie 或 Service Token。生成成功后，如果配置了 Worker secret `PAGES_DEPLOY_HOOK_URL`，会触发 Pages Preview 重新构建，使静态 `/briefing` 获取最新日报。`ZX_SIGNAL_SCHEDULE_ENABLED=false` 可在不删除 Trigger 的情况下暂停流水线。

当前闭环：

```text
RSS / arXiv / Hacker News / GitHub Releases / fixture
→ 规范化、canonical URL 与内容 hash 去重
→ 可审计 editorial filter
→ ZXLab `/api/ai/stream`（Provider fallback，`/generate` 作为兼容后备）
→ 运行时 schema 校验（失败时仅修复一次）
→ D1 原子写入并切换 active 日报
→ /briefing API adapter
→ 选中文字并评论
→ 真实回复 + 可选 Memory Candidate
→ 用户接受或拒绝
→ active Memory 注入下一次生成
```

本阶段支持手动触发 RSS、arXiv、Hacker News 与可选 GitHub Releases 采集；尚未加入 Cron、Workflow、Queue、Vectorize、embedding、自动记忆或多用户系统。fixture 全部标记为 `TEST MATERIAL`，不能视为实时事实。

## Workspace

```text
apps/signal-worker/
  fixtures/candidates.json
  migrations/0001_signal_intelligence_loop.sql
  migrations/0002_collection_pipeline.sql
  src/collectors/
  src/routes/
  src/services/
  src/repositories/
  test/intelligence-loop.test.ts
packages/signal-schema/src/
src/features/briefing/client.ts
```

常用命令：

```bash
npm run types --workspace signal-worker
npm run typecheck --workspace signal-worker
npm test --workspace signal-worker
npm run db:migrate:local --workspace signal-worker
npm run dev:gateway --workspace signal-worker
npm run deploy:dry --workspace signal-worker
```

本地 Signal Worker 通过 HTTPS 调用已部署的 ZXLab 项目网关并产生真实模型用量。复制 `.dev.vars.example`，配置与 Pages 项目一致的内部访问 token 后使用 `dev:gateway`。

## Bindings and configuration

`apps/signal-worker/wrangler.jsonc` 是 Worker 配置的 source of truth：

| Binding / variable | Purpose |
| --- | --- |
| `DB` | D1 `zx-signal` |
| `ZX_SIGNAL_LLM_API_URL` | ZXLab 项目网关 `/api/ai/stream` |
| `ZX_SIGNAL_LLM_API_TOKEN` | 与 Pages `AI_GATEWAY_ACCESS_TOKEN` 相同的服务端 Secret |
| `ZX_SIGNAL_LLM_LABEL` | 日报与回复中使用的逻辑模型标签 |
| `ZX_SIGNAL_USER_AGENT` | arXiv 等要求明确客户端身份的上游请求标识 |
| `ZX_SIGNAL_ALLOWED_ORIGINS` | 精确的 CORS origin 列表 |
| `ZX_SIGNAL_ACCESS_ENABLED` | 生产写操作总开关 |
| `CF_ACCESS_TEAM_DOMAIN` | Access issuer，必须为 `https://<team>.cloudflareaccess.com` |
| `CF_ACCESS_AUD` | Access Application Audience Tag |
| `ZX_SIGNAL_WRITE_TOKEN` | 仅本地开发 Bearer token，使用 Wrangler secret / `.dev.vars` |
| `GITHUB_TOKEN` | 可选 Secret；仅启用 GitHub Releases source 时需要 |

生产 API 使用自定义域名 `https://signal-api.zx-dx.xyz`。Access 应用 `ZX Signal Admin` 只保护管理、批注和 Memory 路径，`/health` 与 `/api/briefings/*` 保持公开。

创建资源后，把 `wrangler.jsonc` 中 D1 的占位 `database_id` 替换为真实 ID：

```bash
cd apps/signal-worker
npx wrangler d1 create zx-signal
npx wrangler d1 migrations apply zx-signal --local
npx wrangler d1 migrations apply zx-signal --remote
npx wrangler types worker-configuration.d.ts
```

Signal 不再直接持有 Provider key，也不再使用 Workers AI binding。它通过 Bearer token 服务端优先调用 ZXLab Pages Function 的 SSE 流式入口；项目网关集中管理 Provider base URL、API key、模型链、重试和 fallback。Signal 在 terminal `done` 事件收到合法 JSON 后仍执行共享业务 schema 与来源白名单校验，失败时 briefing 只允许一次完整修复。若旧部署暂时没有流式入口，Worker 会退回兼容的整包 JSON 入口。

当前 Cloudflare 资源：

```text
D1:     zx-signal / 2968cf60-f38f-4488-8a83-2479d4ba3ee2 (APAC)
Worker: https://signal-api.zx-dx.xyz
LLM API: https://beta.zxlab.pages.dev/api/ai/stream
```

Astro 构建环境：

```text
PUBLIC_SIGNAL_API_BASE=https://<signal-worker-domain>
PUBLIC_SIGNAL_DATA_MODE=api
```

开发环境未显式配置时使用 mock；生产构建未显式配置时使用 `signal-api.zx-dx.xyz`，也可用 `PUBLIC_SIGNAL_API_BASE` 覆盖。API 不可用会显示失败态，不会静默退回 mock。页面元数据会显示 `Mock 预览`、`Fixture 生成` 或 `真实候选生成`。

zxlab 当前仍是 Astro static output，因此日报 API 读取发生在 Pages build 阶段。生成新日报后需要触发一次 Pages 构建才能把新版本写入静态 `/briefing` HTML；批注和 Memory POST 则直接从浏览器请求 Worker。若以后需要“生成完成立即刷新日报”而不重新构建，应把该路由迁移为按需 SSR 或增加客户端渲染层，这不在本阶段的 UI 改动范围内。

## Access control

日报 GET 接口公开。生成、批注、Memory 读取和 Memory 变更受保护。

- 本地：复制 `.dev.vars.example` 为 `.dev.vars`，生成随机 `ZX_SIGNAL_WRITE_TOKEN`，用 `Authorization: Bearer ...` 从 curl 或受信任的后端调用。token 不得放入浏览器 bundle、localStorage 或仓库。
- 生产：`ZX_SIGNAL_ACCESS_ENABLED=true` 时，Worker 从 `Cf-Access-Jwt-Assertion` 读取 token，通过 Team JWKS 验证 RS256 签名，并同时校验 issuer、audience、过期时间和 email。可选的 `Cf-Access-Authenticated-User-Email` 若存在，必须与 JWT email 一致。
- 不要只打开配置开关而不创建 Access policy；开关不是 Access 的替代品。

跨域浏览器请求使用 Access cookie 和 `credentials: include`。如不希望跨域，可将 API 绑定到与 zxlab 同站点的受保护路径。

## Fixture acceptance flow

先启动项目网关开发服务，并从命令行携带本地写 token：

```bash
curl -X POST http://localhost:8788/api/admin/briefings/generate \
  -H 'Authorization: Bearer <local-token>' \
  -H 'Content-Type: application/json' \
  -d '{"date":"2026-07-18","useFixture":true}'
```

然后：

1. 打开 `/briefing`，在 `Agent toolkit runtime fit` 或相近条目选择正文。
2. 评论：`我更关心它能否在 Cloudflare Workers 限制下运行。`
3. 确认建议内容，并选择 `记入 zxlab 项目`；客户端会提交 `scope=project, scopeKey=zxlab`。
4. 用同一 fixture 再次调用生成接口。
5. 新日报的相关条目应主动覆盖 Worker runtime、Node.js API、常驻进程、本地文件系统和迁移边界。

`test/intelligence-loop.test.ts` 使用真实 D1 runtime 和一个确定性测试 LLM 重放同一流程：先生成基线，写入已确认 project memory，再生成同日新版本；测试同时断言旧版本 superseded 以及上述五类运行约束进入新日报输出。真实模型仍需用上面的 fixture 流程验证，因为模型推理不会在离线测试里伪装成线上调用。

项目网关成功响应包含 provider、model、fallback index、usage 与 request id；Signal 将实际选中的 `provider/model` 写入 `model_invocations`，但不记录 prompt、评论、Memory 或模型正文。离线测试使用确定性 LLM；部署后的真实模型仍需重新执行本节 fixture 流程验收。

## API

```text
GET  /api/briefings/latest
GET  /api/briefings/:date
GET  /api/briefings/:id
POST /api/admin/briefings/generate
POST /api/admin/collection-runs
GET  /api/admin/collection-runs/latest
GET  /api/admin/collection-runs/:id
GET  /api/admin/candidates
GET  /api/admin/candidates/:id
POST /api/annotations
GET  /api/memories
POST /api/memory-candidates/:id/accept
POST /api/memory-candidates/:id/reject
```

项目网关请求 JSON 输出，但不会因此被信任。共享 validator 会再次检查字段范围、类别、长度以及 `sourceIds` 是否来自输入候选，任何失败都不会产生半份日报。所有 D1 查询使用 prepared statements；日报版本切换使用 D1 batch transaction。

## D1 ownership

| Table | Responsibility |
| --- | --- |
| `briefing_runs` | 每次生成状态、模型、版本、计数与错误摘要 |
| `briefings` | 可重复生成的日报版本与单日 active 指针 |
| `briefing_items` / `briefing_sources` | 入选判断和输入候选来源 |
| `annotations` / `annotation_messages` | 用户批注与模型回复 |
| `memory_candidates` | 待用户确认或拒绝的建议 |
| `memory_entries` | 仅确认后创建的 active / revoked / expired Memory |
| `memory_events` | 接受、拒绝及后续变更历史 |
| `model_invocations` | task、模型、prompt version、时延状态与可用 usage；不存正文日志 |
| `signal_sources` | 可审计的 source 配置快照 |
| `collection_runs` / `collection_source_runs` | 整体与逐源采集状态、计数和安全错误摘要 |
| `candidate_signals` | 规范化候选、去重关系和 editorial decision |
| `briefing_item_candidates` | 日报条目与原始候选的 primary/supporting 关系 |

Memory 永远不会由模型直接激活。`discussion` 可设置过期时间，`project` 必须有 `scopeKey`，`belief` 始终保留“用户当前判断”语义。
