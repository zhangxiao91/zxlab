import type {
  Annotation,
  AnnotationResponse,
  BriefingPreviewState,
  DailyBriefing,
  MemoryCandidate,
  MemoryScope,
} from "./types";

const baseBriefing: DailyBriefing = {
  id: "briefing-2026-07-18",
  date: "2026-07-18",
  status: "ready",
  title: "边缘约束，正在成为产品判断的一部分",
  summary:
    "今天值得保留的变化并不来自更大的模型，而来自工程边界开始变得清晰：Agent 需要可恢复的状态，评测需要贴近真实任务，个人信息系统则需要把人的反馈变成可审计的长期偏好。市场侧的线索也相似——比起追逐单日价格，更应关注供给纪律和库存结构是否真正改变。",
  generatedAt: "2026-07-18T07:42:00+08:00",
  promptVersion: "editorial-v0.3",
  stats: { fetched: 186, deduplicated: 72, selected: 6 },
  items: [
    {
      id: "agent-durable-state",
      category: "ai-engineering",
      title: "Agent 框架的竞争点正从调用工具转向恢复任务",
      summary:
        "新一轮 Agent 工程讨论开始把 checkpoint、重试边界与人工接管放在核心位置。单次运行能否完成已不是唯一指标，失败后能否从确定状态继续，正在成为更有区分度的工程能力。",
      whatChanged:
        "此前的样例多强调工具数量与多 Agent 协作；现在，持久化状态和可观察的执行历史被提前到架构设计阶段。",
      whyItMatters:
        "ZX Signal 未来运行在 Cloudflare Workflow 上，任务会跨越采集、筛选、总编辑与写入。把每一步设计为可重放的状态转换，比依赖一个长时间存活的进程更贴近实际约束。",
      suggestedAction:
        "先为日报生成定义最小状态机，再评估框架；比较 checkpoint 粒度、幂等重试和人工恢复入口。",
      importance: 92,
      confidence: 88,
      sources: [
        { id: "agent-source-1", title: "Durable execution patterns", url: "https://developers.cloudflare.com/workflows/", publisher: "Cloudflare Docs" },
        { id: "agent-source-2", title: "Agent orchestration notes", url: "https://openai.github.io/openai-agents-js/", publisher: "OpenAI Agents SDK" },
      ],
    },
    {
      id: "context-benchmarks",
      category: "ai-engineering",
      title: "Context Engineering 的评测开始回到真实工作痕迹",
      summary:
        "只测最终答案的 benchmark 很难解释 Agent 为什么失败。更有用的方向，是保留工具调用、上下文裁剪、错误恢复和用户修正，把一整段任务轨迹作为评测对象。",
      whatChanged:
        "关注点从静态题库分数转向轨迹质量、执行成本和在真实约束下完成任务的稳定性。",
      whyItMatters:
        "zxlab 已经有多个可重复的开发任务。它们可以成为低成本私有 benchmark，帮助判断 prompt、memory 或工具升级是否真的改善工作，而不是只改变表达风格。",
      suggestedAction:
        "从发布笔记、修复链接和构建检查中选 5 个任务，记录成功条件、token 成本与人工介入点。",
      importance: 86,
      confidence: 81,
      sources: [
        { id: "bench-source-1", title: "Evaluation design guide", url: "https://platform.openai.com/docs/guides/evals", publisher: "OpenAI Docs" },
      ],
    },
    {
      id: "signal-memory-boundary",
      category: "zxlab",
      title: "ZX Signal 的 memory 不该等同于一张偏好表",
      summary:
        "用户对日报的评论同时包含短期讨论、项目约束、长期偏好与当前判断。若不保留范围、来源与变更历史，同一句反馈会在未来被错误地当成永久事实。",
      whatChanged:
        "设计重点从“保存用户说过的话”转向“保存一条可确认、可限定、可撤销的记忆事件”。",
      whyItMatters:
        "这决定了日报是否会随着使用变得更准确，而不是越来越封闭。memory candidate 必须先由用户确认，并保留它来自哪条内容与哪次评论。",
      suggestedAction:
        "第一阶段只实现 candidate 的确认闭环；未来把 entry 与 event 分表，避免覆盖式更新失去审计记录。",
      importance: 95,
      confidence: 93,
      sources: [
        { id: "memory-source-1", title: "ZX Signal phase-one architecture", url: "/briefing", publisher: "zxlab" },
      ],
    },
    {
      id: "workers-personal-infra",
      category: "zxlab",
      title: "个人基础设施正在从服务器清单变成能力边界",
      summary:
        "对 zxlab 来说，选择服务不再只是比较功能，而是判断它能否在边缘运行时、短任务生命周期、受限文件系统和可控成本内稳定工作。",
      whatChanged:
        "原先按产品名称组织的工具选择，正在转向按运行约束、数据位置与故障恢复方式组织。",
      whyItMatters:
        "这种视角能减少“本地 demo 很顺、部署时全部重写”的实验浪费，也适用于 zxtoolkit 的设备通信和状态页面的数据边界。",
      suggestedAction:
        "为新实验增加一页 deployment fit：运行时、持久化、网络、定时任务、成本上限。",
      importance: 83,
      confidence: 90,
      sources: [
        { id: "infra-source-1", title: "Workers platform limits", url: "https://developers.cloudflare.com/workers/platform/limits/", publisher: "Cloudflare Docs" },
      ],
    },
    {
      id: "memory-supply-cycle",
      category: "markets",
      title: "存储芯片的观察重点从涨价预期转向供给纪律",
      summary:
        "市场叙事仍容易被短期报价推动，但更值得跟踪的是厂商资本开支、产能利用率和高带宽内存对传统产线的挤占是否持续。价格变化只有与供给行为一致时，才更可能构成周期信号。",
      whatChanged:
        "判断框架从单一现货价格，扩展为报价、库存、产能迁移与终端需求的交叉验证。",
      whyItMatters:
        "这能避免把一次渠道补库误认为完整上行周期，也更适合形成可持续跟踪的个人市场观察清单。",
      suggestedAction:
        "保持低频跟踪：月度更新库存与资本开支，只在三类信号同时变化时提高权重。",
      importance: 78,
      confidence: 72,
      sources: [
        { id: "memory-market-source-1", title: "Memory market research sample", url: "https://www.trendforce.com/", publisher: "TrendForce" },
      ],
    },
    {
      id: "gold-industrial-metals",
      category: "markets",
      title: "黄金与工业金属正在讲述两种不同的风险",
      summary:
        "黄金更接近对货币与地缘不确定性的定价，工业金属则更依赖制造业、库存和新增供给。把两者放在同一套“商品上涨”叙事里，会掩盖驱动因素的分化。",
      whatChanged:
        "观察重点从价格同涨同跌，转向上涨是否由实际需求、库存收缩或风险溢价分别驱动。",
      whyItMatters:
        "对个人组合而言，这种拆分比预测短期点位更有用：它能说明持仓承担的是避险、增长还是供给扰动风险。",
      suggestedAction:
        "后续日报将黄金和铜的信号拆开评分，不用同一宏观标签替代各自的供需证据。",
      importance: 74,
      confidence: 76,
      sources: [
        { id: "metals-source-1", title: "Commodity data sample", url: "https://www.worldbank.org/en/research/commodity-markets", publisher: "World Bank" },
      ],
    },
  ],
};

const cloneBriefing = () => structuredClone(baseBriefing);

export function createMockBriefing(state: BriefingPreviewState = "ready"): DailyBriefing {
  const briefing = cloneBriefing();
  if (state === "empty") {
    briefing.items = [];
    briefing.stats.selected = 0;
    return briefing;
  }
  briefing.status = state;
  if (state === "generating" || state === "failed") briefing.items = [];
  if (state === "partial") briefing.items = briefing.items.slice(0, 4);
  return briefing;
}

const memoryScopeByAction: Record<Annotation["action"], MemoryScope> = {
  comment: "discussion",
  explain: "discussion",
  challenge: "belief",
  remember: "preference",
  track: "project",
};

export function createMockAnnotationResponse(annotation: Annotation): AnnotationResponse {
  const edgeConcern = /Cloudflare|Workers|边缘|运行时/i.test(annotation.comment);
  const templates: Record<Annotation["action"], string> = {
    comment: edgeConcern
      ? "这个判断需要进一步收严。核心思路可能成立，但仍要检查完整 Node.js 运行时、长时间常驻进程或本地文件系统等依赖；之后筛选类似项目时，可以先验证边缘运行兼容性。"
      : `你的评论把“${annotation.selectedText.slice(0, 24)}”从信息判断推进到了个人约束。后续日报可以优先寻找反例与可执行条件，而不是继续重复同类结论。`,
    explain: `这段判断的关键不在名词本身，而在它改变了什么决策。结合你的评论，下一次应补充运行边界、失败条件与最小验证方式，避免把方向性变化误当成可直接采用的方案。`,
    challenge: `质疑成立。当前结论更多来自结构性线索，还不足以证明因果关系。之后应优先检查相反证据，并把“${annotation.comment.slice(0, 30)}”作为需要单独验证的假设。`,
    remember: `这条反馈适合先作为候选偏好，而不是自动成为长期规则。我会保留它的来源与适用范围，确认后再影响类似内容的筛选和排序。`,
    track: `已把你的关注点转成持续跟踪条件。后续有新信息时，应判断它是否真正改变“${annotation.selectedText.slice(0, 22)}”的证据，而不是只因主题相同就重复收录。`,
  };

  const memoryText = edgeConcern
    ? "评估 zxlab 可采用的新工具时，优先检查 Cloudflare Workers 兼容性。"
    : `后续判断相关信号时，优先考虑：${annotation.comment.replace(/[。！？!?]+$/, "")}。`;

  return {
    reply: {
      id: `reply-${annotation.id}`,
      annotationId: annotation.id,
      content: templates[annotation.action],
      createdAt: new Date().toISOString(),
      model: "ZX mock editor",
    },
    memoryCandidate: {
      id: `memory-${annotation.id}`,
      annotationId: annotation.id,
      scope: memoryScopeByAction[annotation.action],
      content: memoryText,
      confidence: edgeConcern ? 0.91 : 0.78,
      status: "proposed",
    },
  };
}

export function updateMockMemoryCandidate(
  candidate: MemoryCandidate,
  action: "accept" | "reject",
  scope?: MemoryScope,
): MemoryCandidate {
  return {
    ...candidate,
    scope: scope ?? candidate.scope,
    status: action === "accept" ? "accepted" : "rejected",
  };
}
