# ZX Signal Intelligence Loop

ZX Signal 由两个独立部分组成：Astro `/briefing` 提供阅读、批注与 Watch 工作区，`apps/signal-worker` 负责采集、质量门、D1 持久化、Watch 匹配、批注回复与确认式 Memory。前后端核心契约统一来自 `packages/signal-schema`。

生产 Worker 在 UTC 23:30（北京时间 07:30）运行 Cron Trigger。scheduled handler 在 Worker 内部直接执行采集、编辑筛选和日报生成，不通过公开管理 API，也不依赖浏览器 Access cookie 或 Service Token。生成成功后，如果配置了 Worker secret `PAGES_DEPLOY_HOOK_URL`，会触发 Pages Preview 重新构建，使静态 `/briefing` 获取最新日报。`ZX_SIGNAL_SCHEDULE_ENABLED=false` 可在不删除 Trigger 的情况下暂停流水线。

当前闭环：

```text
RSS / arXiv / Hacker News / GitHub Releases / fixture
→ 规范化、canonical URL 与内容 hash 去重
→ 可审计 editorial filter
→ ZXLab `/api/ai/stream`（Provider fallback；仅传输/协议不兼容时使用 `/generate`）
→ 运行时 schema + Edition Quality Gate（失败时仅修复一次）
→ D1 原子写入并切换 active 日报
→ /briefing API adapter
→ 选中文字并评论
→ 真实回复 + 可选 Memory Candidate
→ 用户接受或拒绝
→ active Memory 注入下一次生成

日报条目 → “继续追踪” → 用户编辑并明确确认条件
→ 独立 Watch Dossier（不写入 Memory）
→ 后续真实日报确定性匹配 → 带来源的待复核 Observation
→ 用户明确结束追踪
```

采集既可由受保护的管理 API 手动触发，也可由生产 Cron 每日执行；支持 RSS、arXiv、Hacker News 与可选 GitHub Releases。当前仍未加入 Workflow、Queue、Vectorize、embedding、自动接受 Memory 或多用户系统。fixture 全部标记为 `TEST MATERIAL`，不能视为实时事实。

日报输出采用编辑部结构：第一条必须是且只能是一个 `lead`，包含导语、核心意义、关键事实、背景、影响、反方观点或不确定性以及后续观察；当候选池至少有 10 个独立 story 时，日报必须生成 10–12 条（其后为 9–11 条 `brief`）。同一 candidate 或 story dossier 不能拆成多个日报条目；候选不足时允许少发，不能把已 drop 或重复报道补回去凑数。共享 schema 与 `EditionQualityGate` 会在写入 D1 前强制验证这一形态。

每期公开契约同时提供 `generationMode: model | deterministic-fallback`、`qualityStatus: passed | degraded`，以及真实的采集、去重后可用、均衡输入、综合输入和发布计数。旧日报或没有对应阶段的手工输入会把未知计数返回为 `null`，页面显示 `—`，不会用候选数伪造处理阶段。模型、采集或确定性降级不会再被统一包装成同一种“已就绪”。

## Workspace

```text
apps/signal-worker/
  fixtures/candidates.json
  migrations/0001_signal_intelligence_loop.sql … 0010_briefing_quality_provenance.sql
  src/memory/
  src/collectors/
  src/routes/
  src/services/
  src/watch/
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

生产 API 使用自定义域名 `https://signal-api.zx-dx.xyz`。Access 应用 `ZX Signal Admin` 保护管理、批注、Watch 和 Memory 路径，`/health` 与 `/api/briefings/*` 保持公开。

创建资源后，把 `wrangler.jsonc` 中 D1 的占位 `database_id` 替换为真实 ID：

```bash
cd apps/signal-worker
npx wrangler d1 create zx-signal
npx wrangler d1 migrations apply zx-signal --local
npx wrangler d1 migrations apply zx-signal --remote
npx wrangler types worker-configuration.d.ts
```

Signal 不再直接持有 Provider key，也不再使用 Workers AI binding。它通过 Bearer token 服务端优先调用 ZXLab Pages Function 的 SSE 流式入口；项目网关集中管理 Provider base URL、API key、模型链、重试和 fallback。Signal 在 terminal `done` 事件收到合法 JSON 后仍执行共享业务 schema、来源白名单与 Edition Quality Gate，失败时 briefing 只允许一次完整修复。SSE 的 `reset` 会清除 provider 切换前的 partial；provider 链已经返回 `ALL_CANDIDATES_FAILED` 时不会再向整包入口重复提交同一请求，只有 endpoint、协议或运输不兼容才使用 `/generate`。

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

zxlab 当前仍是 Astro static output，Pages build 会把当时的日报写入 `/briefing` HTML。浏览器每次非 preview 加载还会读取公开 latest API，并在 `id` 或 `generatedAt` 更新时替换正文，因此无需等待下一次 Pages 构建才能看到已发布日报；Pages deploy hook 仍用于更新静态首屏。批注、Watch 与 Memory 请求通过同源私有 Signal proxy，凭证不会进入浏览器 bundle。

## Access control

日报 GET 接口公开。生成、批注、Watch、Memory 读取和 Memory 变更受保护。

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
GET  /api/watches
POST /api/watches
POST /api/watches/:id/resolve
GET  /api/memories
POST /api/memory-candidates/:id/accept
POST /api/memory-candidates/:id/reject
POST /api/memory/events
POST /api/memory/retrieve
GET  /api/memory/items
POST /api/memory/items
PATCH /api/memory/items/:id
POST /api/memory/items/:id/forget
POST /api/memory/consolidate
```

`/api/watches*` 只接受受保护请求。创建时服务端重新读取 `briefingId + briefingItemId` 对应的真实日报条目和来源，fixture 不能成为 Watch seed；客户端只能提交可编辑 condition。相同条目和相同规范化 condition 的重试是幂等的。后续只有 `ready + real` 日报参与确定性相似匹配。Observation 是待复核线索，不代表 condition 已成立，且 fixture 不会生成 Observation。

Watch v1 延续 zxlab 当前的单用户 Access 假设，不在 dossier 内另存 owner。不要把同一 Signal Access policy 开放给多个互不信任的主体；引入多用户前必须增加签名 actor envelope、owner 持久化以及 list/resolve 的主体过滤与审计。

`/api/memories` 与 `/api/memory-candidates/*` 是 briefing UI 的兼容接口。新功能使用 `/api/memory/*` 统一接口；所有 Memory 接口均受 Signal Worker 现有 Access / 本地 Bearer 认证保护。`action=track` 不运行 Memory extraction，也不会自动创建 Watch；只有用户在确认区再次提交才会持久化 Watch。

项目网关请求 JSON 输出，但不会因此被信任。共享 validator 会再次检查字段范围、类别、长度以及 `sourceIds` 是否来自输入候选，任何失败都不会产生半份日报。所有 D1 查询使用 prepared statements；日报版本切换使用 D1 batch transaction。

## D1 ownership

| Table | Responsibility |
| --- | --- |
| `briefing_runs` | 每次生成状态、模型、版本、计数与错误摘要 |
| `briefings` | 可重复生成的日报版本、单日 active 指针、generation mode 与 quality status |
| `briefing_items` / `briefing_sources` | 主报道/短讯正文和输入候选来源 |
| `annotations` / `annotation_messages` | 用户批注与模型回复 |
| `memory_candidates` | 待用户确认或拒绝的建议 |
| `memory_items` / `memory_revisions` | 统一的 active / forgotten Memory 与修订审计历史 |
| `feedback_events` / `memory_consolidation_candidates` | 交互反馈与必须人工确认的合并建议 |
| `memory_entries` | 旧 briefing Memory 兼容表；迁移后不再是新代码的主存储 |
| `memory_events` | 接受、拒绝及后续变更历史 |
| `model_invocations` | task、模型、prompt version、时延状态与可用 usage；不存正文日志 |
| `signal_sources` | 可审计的 source 配置快照 |
| `collection_runs` / `collection_source_runs` | 整体与逐源采集状态、计数和安全错误摘要 |
| `candidate_signals` | 规范化候选、去重关系和 editorial decision |
| `briefing_item_candidates` | 日报条目与原始候选的 primary/supporting 关系 |
| `watch_dossiers` / `watch_observations` | 与 Memory 分离的确认式追踪条件、状态和来源快照 |

生成真实日报前，Signal 会把同一批次中标题语义高度相近的候选聚合为临时 story dossier，并查询过去 30 天的 `selected` / `eligible` 候选及更早的 active briefing 条目。历史材料只用于判断连续性、升级、矛盾和真正新增的信息，不能作为当天来源引用。editorial filter 标记为 `merge` 且指向已保留主候选的条目，会继续进入 synthesis，最终可记录为同一条目的 `supporting` 来源。Quality Gate 禁止把该 dossier 再拆成多条；确定性降级还会按 dossier、canonical URL、content hash 和规范化标题先选独立代表。该阶段使用确定性计算，不增加模型调用。

Memory 永远不会由模型直接激活。`discussion` 可设置过期时间，`project` 必须有 `scopeKey`，`belief` 始终保留“用户当前判断”语义。
