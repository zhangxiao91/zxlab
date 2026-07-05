export type DigitalStarterRouteId = "computer" | "ai" | "coding";

export type DigitalStarterStatus = "planned" | "draft" | "ready";

export type DigitalStarterResourceType =
  | "link"
  | "document"
  | "asset"
  | "file"
  | "prompt"
  | "task";

export interface DigitalStarterRoute {
  id: DigitalStarterRouteId;
  title: string;
  description: string;
  modules: string[];
  status: DigitalStarterStatus;
  links: string[];
  assets: string[];
  docs: string[];
}

export interface DigitalStarterResource {
  id: string;
  title: string;
  type: DigitalStarterResourceType;
  routeId: DigitalStarterRouteId;
  description: string;
  url: string;
  status: DigitalStarterStatus;
  tags: string[];
}

export interface DigitalStarterDoc {
  id: string;
  title: string;
  routeId: DigitalStarterRouteId;
  description: string;
  path: string;
  status: DigitalStarterStatus;
  updatedAt: string;
}

export interface DigitalStarterAsset {
  id: string;
  title: string;
  routeId: DigitalStarterRouteId;
  fileType: string;
  description: string;
  url: string;
  status: DigitalStarterStatus;
}

export interface DigitalStarterUpdate {
  date: string;
  title: string;
  description: string;
}

export const digitalStarterRoutes: DigitalStarterRoute[] = [
  {
    id: "computer",
    title: "只想会用电脑",
    description:
      "适合刚开始熟悉电脑，希望掌握文件管理、截图、解压、软件安装和多设备同步的同学。",
    modules: ["电脑基础", "键盘与快捷键", "软件工具", "跨设备同步"],
    status: "draft",
    links: ["computer-tools"],
    assets: ["computer-slides"],
    docs: ["computer-basics"],
  },
  {
    id: "ai",
    title: "想用 AI 提效",
    description: "适合想用 AI 辅助学习、整理资料、写作和制作展示内容的同学。",
    modules: ["AI 入门", "AI 做 PPT"],
    status: "draft",
    links: ["ai-toolkit"],
    assets: ["ai-ppt-example"],
    docs: ["ai-first-steps"],
  },
  {
    id: "coding",
    title: "想试试编程",
    description:
      "适合对编程有一点好奇，想从文档、命令行、代码托管和 AI 辅助写代码开始体验的同学。",
    modules: ["Markdown", "helloworld", "命令行", "GitHub", "vibe coding"],
    status: "planned",
    links: ["github-start"],
    assets: ["coding-examples"],
    docs: ["markdown-github"],
  },
];

export const digitalStarterResources: DigitalStarterResource[] = [
  {
    id: "computer-tools",
    title: "常用工具链接",
    type: "link",
    routeId: "computer",
    description: "浏览器、压缩工具、截图工具和跨设备同步工具的入口占位。",
    url: "#",
    status: "planned",
    tags: ["工具链接", "电脑基础"],
  },
  {
    id: "computer-basics-doc",
    title: "电脑基础文档",
    type: "document",
    routeId: "computer",
    description: "文件管理、软件安装、截图和压缩解压的文档入口。",
    url: "/lab/digital-starter/docs/computer-basics",
    status: "planned",
    tags: ["文档", "文件管理"],
  },
  {
    id: "starter-slides",
    title: "培训课件资产",
    type: "asset",
    routeId: "computer",
    description: "后续接入 PDF、Keynote 或 PPT 文件的统一位置。",
    url: "/assets/digital-starter/slides/",
    status: "planned",
    tags: ["课件", "资产"],
  },
  {
    id: "coding-samples",
    title: "示例文件",
    type: "file",
    routeId: "coding",
    description: "Markdown 示例、helloworld 代码和命令行练习文件占位。",
    url: "/assets/digital-starter/examples/",
    status: "planned",
    tags: ["示例代码", "Markdown"],
  },
  {
    id: "prompt-pack",
    title: "Prompt 模板",
    type: "prompt",
    routeId: "ai",
    description: "整理资料、生成大纲、改写表达和制作 PPT 的 Prompt 模板入口。",
    url: "/lab/digital-starter/docs/prompt-templates",
    status: "planned",
    tags: ["Prompt", "AI"],
  },
  {
    id: "starter-tasks",
    title: "实战任务",
    type: "task",
    routeId: "coding",
    description: "用于后续放置轻量练习任务，不做复杂学习进度系统。",
    url: "/lab/digital-starter/docs/tasks",
    status: "planned",
    tags: ["任务", "练习"],
  },
];

export const digitalStarterDocs: DigitalStarterDoc[] = [
  {
    id: "computer-basics",
    title: "电脑基础入门",
    routeId: "computer",
    description: "文件、截图、压缩解压和软件安装的最小可用指南。",
    path: "/lab/digital-starter/docs/computer-basics",
    status: "planned",
    updatedAt: "2026-07-05",
  },
  {
    id: "ai-first-steps",
    title: "AI 工具第一步",
    routeId: "ai",
    description: "如何把 AI 用在资料整理、学习计划和展示准备中。",
    path: "/lab/digital-starter/docs/ai-first-steps",
    status: "planned",
    updatedAt: "2026-07-05",
  },
  {
    id: "markdown-github",
    title: "Markdown 与 GitHub 入门",
    routeId: "coding",
    description: "从写一份文档开始，理解命令行、仓库和代码托管。",
    path: "/lab/digital-starter/docs/markdown-github",
    status: "planned",
    updatedAt: "2026-07-05",
  },
];

export const digitalStarterAssets: DigitalStarterAsset[] = [
  {
    id: "computer-slides",
    title: "电脑基础课件",
    routeId: "computer",
    fileType: "PPT/PDF",
    description: "培训课件下载位，第一版只预留路径。",
    url: "/assets/digital-starter/computer-basics/",
    status: "planned",
  },
  {
    id: "ai-ppt-example",
    title: "AI 做 PPT 示例",
    routeId: "ai",
    fileType: "PPTX",
    description: "后续接入 AI 辅助制作展示内容的示例文件。",
    url: "/assets/digital-starter/ai-ppt/",
    status: "planned",
  },
  {
    id: "coding-examples",
    title: "编程入门示例",
    routeId: "coding",
    fileType: "ZIP",
    description: "Markdown、helloworld 和命令行练习文件的集合入口。",
    url: "/assets/digital-starter/coding-examples/",
    status: "planned",
  },
];

export const digitalStarterUpdates: DigitalStarterUpdate[] = [
  {
    date: "2026-07-05",
    title: "MVP 骨架建立",
    description: "完成三条路线、资料入口和后续接入数据结构的第一版页面。",
  },
  {
    date: "下一步",
    title: "接入真实资源",
    description: "补充课件、Prompt 模板、示例文件和文档内容。",
  },
];

export const digitalStarterResourceTypeLabels: Record<DigitalStarterResourceType, string> = {
  link: "外链",
  document: "文档",
  asset: "课件资产",
  file: "示例文件",
  prompt: "Prompt 模板",
  task: "实战任务",
};
