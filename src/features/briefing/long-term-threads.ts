import type { LongTermThread } from "./types";

export const DEFAULT_LONG_TERM_THREADS: LongTermThread[] = [
  { id: "default-agent-workflows", title: "Agent 工作流", description: "观察持久化状态、幂等重试与人工恢复边界。", category: "ai-engineering", dossierIds: [] },
  { id: "default-memory-cycle", title: "存储芯片周期", description: "交叉验证库存、资本开支与产能迁移。", category: "markets", dossierIds: [] },
  { id: "default-zxlab-infrastructure", title: "zxlab 基础设施", description: "追踪边缘运行适配、数据边界与成本上限。", category: "zxlab", dossierIds: [] },
  { id: "default-low-cost-benchmark", title: "低成本 Benchmark", description: "用真实开发轨迹检验 prompt、memory 与工具变化。", category: "ai-engineering", dossierIds: [] },
];

export function resolveLongTermThreads(threads: LongTermThread[] | undefined): {
  threads: LongTermThread[];
  usingDefault: boolean;
} {
  const generated = (threads ?? []).slice(0, 4);
  return generated.length >= 2
    ? { threads: generated, usingDefault: false }
    : { threads: DEFAULT_LONG_TERM_THREADS, usingDefault: true };
}
