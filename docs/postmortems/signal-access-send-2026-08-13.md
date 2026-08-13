# Signal Cloudflare Access 发送故障复盘

- 日期：2026-08-13
- 影响入口：`https://beta.zxlab.pages.dev/briefing/`
- 修复提交：`0165fd08 fix(signal): route streaming sends through Pages`
- 最终状态：2026-08-13，用户确认已在真实 Cloudflare Access 会话中完成 annotation 发送和回复检查，端到端验收完成。

## 验收证据

- `0165fd08` 对应的 beta Pages deployment 已 Active，线上 bundle 已确认使用修正后的 private route 选择。
- 无凭据的 annotation POST 返回应用层 `401 ACCESS_REQUIRED`，说明修复没有放宽 Pages 鉴权。
- 最终真人验收由用户在当前对话中明确确认。人的 Access Cookie、annotation 正文和回复内容没有导出或写入文档；因此这条记录是人工验收声明，不伪装成可回放的机器 trace。

## 摘要

这次故障表面上表现为“已经完成 Cloudflare Access 授权，仍然无法发送”，但最终根因不是 Access Cookie 或 JWT 无效，而是客户端错误地选择了请求目标。

流式发送调用 `/api/annotations?stream=1`。旧的 private route 分类直接对完整字符串执行 `path === "/api/annotations"`；加入 query 后匹配失败，请求没有进入同源 `/api/signal/*` Pages gateway。Access、Pages、Runtime 和 Signal 各层的局部能力可以正常，但用户真实发送链仍然失败。

事故耗时的主要原因不是单纯的 Cloudflare 复杂度，而是没有在第一轮建立“用户点击后，浏览器最终发往哪个 URL”的红色反馈环。排查被 Access 文案锚定，连续修复了多个真实但相邻的问题，并过早把局部验证描述为问题已经解决。

## 时间线

### 潜伏期

- 2026-07-20，`2512c532` 将流式请求从 `Accept: text/event-stream` 改为 `?stream=1`，以避免 Accept preflight。
- 2026-07-27，`15016f09` 引入统一 private browser session，并用完整 path 字符串判断 public/private route。
- 两次修改各自的局部测试都通过，但没有组合测试执行真实 caller 并检查最终 fetch URL。

### 处理期

- `2e089255`：暴露 protected annotation 登录入口。
- `4c41cea7`、`6a3d69df`：增加授权完成后的发送恢复，并兼容缺少 channel API 的浏览器。
- `b8013dbb`、`f26eda29`：恢复前验证 Signal session，并区分上游鉴权错误。
- `3eba3afc`：同标签页授权、sessionStorage 草稿保留与自动重发。
- `bcc5caa4`：增加同源 `/api/signal/*` Pages gateway，验证浏览器签名会话。
- `0165fd08`：发现并修复带 query 的流式 annotation 未被识别为 private route 的直接根因。
- 用户随后在真实 Access 会话中完成发送，E2E 通过。

前述修复多数解决了真实的邻近缺陷，并非无效代码；错误在于没有证明它们与原始发送失败的因果关系，就将其视为最终修复。

## 根因分层

### 直接代码缺陷

权限路由器把 raw path 当成 pathname。`/api/annotations` 命中 private route，`/api/annotations?stream=1` 不命中。query 意外改变了鉴权归属。

### 诊断遮蔽

客户端曾把一般的 `Failed to fetch`、CORS、网络中断等统一翻译成“需要完成 Cloudflare Access 授权”。错误提示把产品和排查同时锚定到 Access，即使真正问题发生在首跳路由。

stream 与 non-stream fallback 是两条不同状态路径：只有 fetch 抛异常时才 fallback；HTTP 非成功响应和 opaque redirect 会直接抛错。不同浏览器可能呈现不同症状，进一步增加了误导性。

### 流程根因

没有先建立 exact-symptom、可重复、可自动运行的红色反馈环。修复 session、恢复 UI 和 Pages proxy 前，没有先回答：

- 点击后是否真的产生 POST；
- 完整 URL 和 query 是什么；
- 请求停在 Browser、Pages、Runtime 还是 Signal；
- 每层的 status/error code 是什么。

### 环境放大器

链路包含 Access → Pages → Runtime → Signal → SSE/LLM，各层独立部署、鉴权和日志。人的浏览器会话不能导出，机器身份也不能冒充人。同期 Codex 内浏览器还存在独立的 DNS/Statsig 超时。这些因素增加了观测成本，但不能解释在原始反馈环未建立时连续下结论。

## 为什么测试没有发现

测试覆盖了三个局部，却没有覆盖它们的连接：

- Worker 测试直接调用 `/api/annotations?stream=1` handler，绕过客户端和 Pages。
- Pages proxy 测试手工传入了正确的 proxy URL，只证明请求到达后可以转发 query。
- 前端测试主要用源码正则确认 `/api/signal` 存在，没有执行 `submitAnnotationStream()` 并检查最终 fetch URL。
- DEV 默认使用 mock，且 public/private base 可能相同，无法暴露错误选路。
- typecheck、build、链接检查不验证网络语义。

本次已补 Browser caller、Pages handler、Runtime bridge、Signal Worker entrypoint 四个合同 seam，并将它们聚合为固定脚本。它们是分段合同，不冒充真实 Cloudflare E2E。

## 做得正确的部分

- 没有绕过 Cloudflare Access，也没有读取、导出或复用人的 Cookie/JWT。
- 始终保留无凭据请求的关闭状态，修复后仍返回应用层 `401 ACCESS_REQUIRED`。
- 已认证的 `GET watches 200` 证明人的 Access 会话和 read scope 有效；三层 tail 在失败复现时都没有 annotation POST，则把故障定位到 Pages 之前。两类证据没有混用。
- 修复前建立了 `/api/annotations?stream=1` 的确定性红色回归测试。
- 最终以真实 human session 的成功发送作为 E2E 完成条件。

## 完成语义

以后必须分别报告四个状态：

1. Local verified：正确 seam 的 focused tests、typecheck、build 通过。
2. Preview deployed：预期 commit SHA 的 beta Pages deployment 为 Active。
3. Security boundary verified：无凭据或无权限请求仍被拒绝。
4. Authenticated E2E verified：真实用户会话完成原始写操作并看到终态结果。

只有第 4 项通过，才能对用户报告“问题已修好”。`GET watches 200` 只证明 session/read；invalid POST 到达领域 4xx 只证明 route reachability；两者都不能替代真实发送。

## 固化门禁

### 自动化

- `npm run test:signal-contract`：Browser caller、route query、Pages gateway、Runtime bridge、Signal entrypoint 与 private proxy 合同。
- `npm run test:signal-web`：Signal briefing/Access/Pages 的完整根测试集合。
- `npm run verify:signal:local`：Signal Web、Runtime Worker、Signal Worker 与根 typecheck。
- 根 `npm run build` 前置执行 `test:signal-contract`，避免 beta build 在关键合同失败时继续。

合同测试至少覆盖：

- `POST /api/signal/api/annotations?stream=1`；
- `credentials: include`、JSON body 与 `actionType`；
- Pages 保留 method、query、body、SSE content type，且不转发浏览器 Cookie；
- Runtime 保留 annotation query、method、body、content type 与 SSE；
- Signal entrypoint 接受 Runtime bearer 和 `actionType` body，并产生终态 `done`；
- generic network failure 和 SSE error 不得伪装为 Access failure。

### 调试与发布

1. 复现前开启绑定到预期 beta deployment 的 Pages tail，以及 `zx-runtime`、`zx-signal` tail。
2. 第一次复现记录 URL、method、status；若链路已有安全 request ID，再一起记录。没有原始红色证据，不进入修复阶段。
3. 浏览器控制工具故障 15 分钟止损，转 CLI、tail、已连接 Chrome 或结构化人工复现。
4. beta 必须执行 focused tests、`verify:signal:local`、完整 build、Conventional Commit、push，并等待预期 SHA Active。
5. 安全负例与真实 human-session E2E 分别验收，不互相替代。

## 后续架构方向

- 将 public/private access、method、pathname、search 显式建模；调用方直接声明 private，不再从 raw string 猜权限。
- 收敛 stream/non-stream transport，统一 URL 构造、错误分类、timeout 与 fallback 语义。
- 设计由可信入口生成、各层严格验证的安全 request ID，再让 Pages、Runtime、Signal 透传。transport trace 只记录受限 event/service、ID、method、pathname、stage、status、duration 和错误码，不记录 query、自由文本错误、身份、凭据或用户正文。
- 评估 annotation stream fallback 的幂等键，避免网络中断后 fallback 造成重复写入。

## 反事实最短路径

最短路径本应是：先开三层 tail，让用户点击一次；发现 Pages 没有 annotation POST；检查浏览器最终目标；用两秒路由测试复现 `/api/annotations?stream=1`；修一次、部署一次、真人验证一次。

本次复盘的核心教训是：局部绿灯不会自动组成 E2E 绿灯；没有原始流程变绿，就不能宣布完成。
