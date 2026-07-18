# ZX Signal architecture

ZX Signal 的第一阶段是一条完全在浏览器内运行的垂直切片。`/briefing` 只依赖共享类型和 briefing client，不直接读取 mock 数据；批注、模拟回复与 memory candidate 通过独立 session store 写入 `localStorage`。这让 UI 的交互契约可以在后端接入前稳定下来。

## Future Cloudflare flow

```text
Cloudflare Cron
→ Cloudflare Workflow
→ Collectors
→ LLM 初筛
→ LLM 总编辑
→ D1
→ Signal Worker API
→ zxlab /briefing
```

未来只需要把 `src/features/briefing/client.ts` 中的 mock adapter 替换为 Worker API 请求。页面组件继续消费 `DailyBriefing`、`Annotation`、`AnnotationReply` 和 `MemoryCandidate`，不感知 D1 或模型供应商。

预留接口：

```text
GET  /api/briefings/latest
GET  /api/briefings/:date
POST /api/annotations
POST /api/annotations/:id/reply
POST /api/memory-candidates/:id/accept
POST /api/memory-candidates/:id/reject
```

## D1 ownership

| Table | Responsibility |
| --- | --- |
| `briefing_runs` | Workflow 单次运行、状态、版本、计数与错误摘要 |
| `briefings` | 每日总编辑结果与生成元数据 |
| `briefing_items` | 入选条目、分类、判断、重要性与置信度 |
| `briefing_sources` | 条目来源、发布时间与抓取引用 |
| `annotations` | 用户选中文字、action 类型与评论 |
| `annotation_messages` | 用户与 LLM 围绕批注产生的消息 |
| `memory_candidates` | 尚待确认或已处理的 memory 建议 |
| `memory_entries` | 当前有效、带范围的 memory 内容 |
| `memory_events` | memory 的确认、忽略、改范围与撤销历史 |

`memory_entries` 不应被模型直接写入。模型只创建 `memory_candidates`；用户确认后由 API 在一个事务中追加 `memory_events` 并创建或更新 entry，以保留来源和审计记录。

## Phase-one boundaries

本阶段不包含真实采集、模型调用、D1 migration、Workflow、Cron、账户、搜索、行情或全站批注。mock 内容是结构化演示数据，不代表实时事实或投资建议。
