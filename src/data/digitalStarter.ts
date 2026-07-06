export type DigitalStarterRouteId = "computer" | "ai" | "coding";

export type DigitalStarterStatus =
  | "planned"
  | "draft"
  | "ready"
  | "writing"
  | "todo"
  | "pending";

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
  subtitle?: string;
  description: string;
  modules: string[];
  status: DigitalStarterStatus;
  links: string[];
  assets: string[];
  docs: string[];
  resourceIds: string[];
  detailHref?: string;
}

export interface DigitalStarterRouteModule {
  id: string;
  routeId: DigitalStarterRouteId;
  title: string;
  description: string;
  capabilities: string[];
  task: string;
  toolCategories?: string[];
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
  actionLabel: "打开" | "查看" | "下载" | "复制";
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

export const digitalStarterResourceTypeLabels: Record<DigitalStarterResourceType, string> = {
  link: "外链",
  document: "文档",
  asset: "课件资产",
  file: "示例文件",
  prompt: "Prompt 模板",
  task: "实战任务",
};

export const digitalStarterResourceTypeMarks: Record<DigitalStarterResourceType, string> = {
  link: "LINK",
  document: "DOC",
  asset: "ASSET",
  file: "FILE",
  prompt: "PROMPT",
  task: "TASK",
};

export const digitalStarterStatusLabels: Record<DigitalStarterStatus, string> = {
  planned: "待接入",
  draft: "草稿中",
  ready: "可用",
  writing: "编写中",
  todo: "待补充",
  pending: "待接入",
};

export const digitalStarterRoutes: DigitalStarterRoute[] = [
  {
    id: "computer",
    title: "只想会用电脑",
    subtitle: "从文件、快捷键、软件安装到跨设备同步，先把电脑用顺手。",
    description:
      "这条路线适合刚开始熟悉电脑的同学。它会帮你掌握大学生活里最常遇到的基础操作：找到文件、整理资料、安装软件、截图解压、使用快捷键，以及在手机、电脑和平板之间同步重要资料。",
    modules: ["电脑基础", "键盘与快捷键", "软件工具", "跨设备同步"],
    status: "draft",
    links: [],
    assets: ["college-folder-template"],
    docs: [
      "computer-basics-cheatsheet",
      "keyboard-shortcuts-doc",
      "safe-download-guide",
      "sync-plan-doc",
    ],
    resourceIds: [
      "computer-basics-cheatsheet",
      "keyboard-shortcuts-doc",
      "safe-download-guide",
      "college-folder-template",
      "screenshot-unzip-task",
      "sync-plan-doc",
    ],
    detailHref: "/lab/digital-starter/computer",
  },
  {
    id: "ai",
    title: "想用 AI 提效",
    description: "适合想用 AI 辅助学习、整理资料、写作和制作展示内容的同学。",
    modules: ["AI 入门", "AI 做 PPT"],
    status: "draft",
    links: [],
    assets: ["ai-ppt-example-asset"],
    docs: ["ai-intro-doc"],
    resourceIds: ["ai-intro-doc", "ai-ppt-prompt", "ai-ppt-example-asset"],
  },
  {
    id: "coding",
    title: "想试试编程",
    description:
      "适合对编程有一点好奇，想从文档、命令行、代码托管和 AI 辅助写代码开始体验的同学。",
    modules: ["Markdown", "helloworld", "命令行", "GitHub", "vibe coding"],
    status: "planned",
    links: ["github-example-repo"],
    assets: ["personal-start-page-file"],
    docs: ["markdown-start-doc"],
    resourceIds: ["markdown-start-doc", "github-example-repo", "personal-start-page-file"],
  },
];

export const digitalStarterRouteModules: DigitalStarterRouteModule[] = [
  {
    id: "computer-basics",
    routeId: "computer",
    title: "电脑基础",
    description:
      "学会开关机、重启、文件夹、路径、下载目录、软件安装、卸载、截图、压缩和解压。",
    capabilities: [
      "知道下载的文件在哪里",
      "能整理自己的文件夹",
      "能区分安装包和软件本体",
      "能截图并标注",
      "能解压 zip / rar / 7z 文件",
      "能卸载不需要的软件",
    ],
    task: "整理一个“大学资料”文件夹。",
  },
  {
    id: "keyboard-shortcuts",
    routeId: "computer",
    title: "键盘与快捷键",
    description: "掌握最常用的键盘操作和快捷键，让电脑用起来更顺手。",
    capabilities: [
      "复制、粘贴、剪切、撤销、保存",
      "全选、查找、切换窗口",
      "浏览器新建标签页、关闭标签页、打开地址栏",
      "Windows / macOS 截图快捷键",
      "中英文输入法切换",
      "常见符号输入",
    ],
    task: "用快捷键完成一段文字的复制、修改、保存和截图。",
  },
  {
    id: "software-toolkit",
    routeId: "computer",
    title: "软件工具",
    description: "建立一套适合大学生活的基础软件工具箱，不追求装得多，先覆盖真实需求。",
    capabilities: [
      "从官网或可信来源下载软件",
      "识别假下载按钮和捆绑安装",
      "知道每类工具解决什么问题",
      "能管理浏览器插件",
      "能清理不用的软件",
    ],
    toolCategories: [
      "浏览器",
      "广告过滤插件",
      "视频播放器",
      "压缩解压",
      "截图录屏",
      "文件搜索",
      "文档与 PDF",
      "笔记工具",
      "密码管理",
      "同步备份",
    ],
    task: "建立自己的“常用软件清单”。",
  },
  {
    id: "device-sync",
    routeId: "computer",
    title: "跨设备同步",
    description: "让手机、电脑和平板之间可以稳定传文件、同步资料和备份重要内容。",
    capabilities: [
      "区分临时传输和长期同步",
      "知道微信文件传输助手、网盘、iCloud、OneDrive 等方案适合什么场景",
      "知道同步冲突和误删风险",
      "能备份证件、录取资料、课程资料和项目文件",
      "不把敏感资料随便上传到陌生平台",
    ],
    task: "设计自己的多设备同步方案。",
  },
];

export const digitalStarterDocs: DigitalStarterDoc[] = [
  {
    id: "computer-basics-cheatsheet",
    title: "电脑基础速查表",
    routeId: "computer",
    description: "整理开关机、文件夹、下载、截图、解压、软件安装等基础操作。",
    path: "/lab/digital-starter/docs/computer-basics",
    status: "writing",
    updatedAt: "2026-07-06",
  },
  {
    id: "keyboard-shortcuts-doc",
    title: "键盘快捷键清单",
    routeId: "computer",
    description: "收集 Windows 和 macOS 最常用快捷键，适合新手反复查看。",
    path: "/lab/digital-starter/docs/keyboard-shortcuts",
    status: "todo",
    updatedAt: "2026-07-06",
  },
  {
    id: "safe-download-guide",
    title: "安全下载软件指南",
    routeId: "computer",
    description: "说明如何找到官网、识别假下载按钮、避免捆绑安装和恶意软件。",
    path: "/lab/digital-starter/docs/safe-download",
    status: "writing",
    updatedAt: "2026-07-06",
  },
  {
    id: "sync-plan-doc",
    title: "跨设备同步方案",
    routeId: "computer",
    description: "介绍手机、电脑、平板之间传文件、同步和备份的基本方案。",
    path: "/lab/digital-starter/docs/device-sync",
    status: "todo",
    updatedAt: "2026-07-06",
  },
  {
    id: "ai-intro-doc",
    title: "AI 入门讲义",
    routeId: "ai",
    description: "AI 工具的基本使用方式、边界和适合新生的轻量场景。",
    path: "/lab/digital-starter/docs/ai-intro",
    status: "planned",
    updatedAt: "2026-07-06",
  },
  {
    id: "markdown-start-doc",
    title: "Markdown 入门",
    routeId: "coding",
    description: "从写一份清晰文档开始，体验文本、预览和版本管理。",
    path: "/lab/digital-starter/docs/markdown-start",
    status: "planned",
    updatedAt: "2026-07-06",
  },
];

export const digitalStarterAssets: DigitalStarterAsset[] = [
  {
    id: "college-folder-template",
    title: "大学资料文件夹模板",
    routeId: "computer",
    fileType: "ZIP",
    description: "提供一套适合大学新生的文件夹结构示例。",
    url: "/assets/digital-starter/computer/",
    status: "pending",
  },
  {
    id: "ai-ppt-example-asset",
    title: "PPT 示例文件",
    routeId: "ai",
    fileType: "PPTX",
    description: "后续接入 AI 辅助制作展示内容的示例文件。",
    url: "/assets/digital-starter/ai-ppt/",
    status: "planned",
  },
  {
    id: "personal-start-page-file",
    title: "个人起点页示例",
    routeId: "coding",
    fileType: "HTML/ZIP",
    description: "后续放置一个极小的个人起点页示例和下载文件。",
    url: "/assets/digital-starter/examples/",
    status: "planned",
  },
];

export const digitalStarterResources: DigitalStarterResource[] = [
  {
    id: "computer-basics-cheatsheet",
    title: "电脑基础速查表",
    type: "document",
    routeId: "computer",
    description: "整理开关机、文件夹、下载、截图、解压、软件安装等基础操作。",
    url: "/lab/digital-starter/docs/computer-basics",
    status: "writing",
    tags: ["文档", "电脑基础"],
    actionLabel: "查看",
  },
  {
    id: "keyboard-shortcuts-doc",
    title: "键盘快捷键清单",
    type: "document",
    routeId: "computer",
    description: "收集 Windows 和 macOS 最常用快捷键，适合新手反复查看。",
    url: "/lab/digital-starter/docs/keyboard-shortcuts",
    status: "todo",
    tags: ["文档", "快捷键"],
    actionLabel: "查看",
  },
  {
    id: "safe-download-guide",
    title: "安全下载软件指南",
    type: "document",
    routeId: "computer",
    description: "说明如何找到官网、识别假下载按钮、避免捆绑安装和恶意软件。",
    url: "/lab/digital-starter/docs/safe-download",
    status: "writing",
    tags: ["文档", "软件工具"],
    actionLabel: "查看",
  },
  {
    id: "college-folder-template",
    title: "大学资料文件夹模板",
    type: "file",
    routeId: "computer",
    description: "提供一套适合大学新生的文件夹结构示例。",
    url: "/assets/digital-starter/computer/",
    status: "pending",
    tags: ["示例文件", "文件管理"],
    actionLabel: "下载",
  },
  {
    id: "screenshot-unzip-task",
    title: "截图与解压练习",
    type: "task",
    routeId: "computer",
    description: "通过一个小任务练习截图、标注、压缩和解压。",
    url: "/lab/digital-starter/docs/tasks#screenshot-unzip",
    status: "todo",
    tags: ["任务", "文件管理"],
    actionLabel: "查看",
  },
  {
    id: "sync-plan-doc",
    title: "跨设备同步方案",
    type: "document",
    routeId: "computer",
    description: "介绍手机、电脑、平板之间传文件、同步和备份的基本方案。",
    url: "/lab/digital-starter/docs/device-sync",
    status: "todo",
    tags: ["文档", "同步备份"],
    actionLabel: "查看",
  },
  {
    id: "ai-intro-doc",
    title: "AI 入门讲义",
    type: "document",
    routeId: "ai",
    description: "面向新生的 AI 工具基本概念、使用边界和学习场景。",
    url: "/lab/digital-starter/docs/ai-intro",
    status: "planned",
    tags: ["文档", "AI"],
    actionLabel: "查看",
  },
  {
    id: "ai-ppt-prompt",
    title: "AI 做 PPT Prompt",
    type: "prompt",
    routeId: "ai",
    description: "把资料整理成展示大纲、页面结构和讲稿提示词的占位模板。",
    url: "/lab/digital-starter/docs/prompt-templates#ai-ppt",
    status: "planned",
    tags: ["Prompt", "PPT"],
    actionLabel: "复制",
  },
  {
    id: "ai-ppt-example-asset",
    title: "PPT 示例文件",
    type: "asset",
    routeId: "ai",
    description: "用于后续接入 PPTX、PDF 或图片素材的资产入口。",
    url: "/assets/digital-starter/ai-ppt/",
    status: "planned",
    tags: ["课件资产", "PPT"],
    actionLabel: "下载",
  },
  {
    id: "markdown-start-doc",
    title: "Markdown 入门",
    type: "document",
    routeId: "coding",
    description: "从标题、列表、链接和代码块开始，写一份可维护的学习文档。",
    url: "/lab/digital-starter/docs/markdown-start",
    status: "planned",
    tags: ["文档", "Markdown"],
    actionLabel: "查看",
  },
  {
    id: "github-example-repo",
    title: "GitHub 示例仓库",
    type: "link",
    routeId: "coding",
    description: "用于后续连接示例代码仓库，先保留统一外链入口。",
    url: "#",
    status: "planned",
    tags: ["外链", "GitHub"],
    actionLabel: "打开",
  },
  {
    id: "personal-start-page-file",
    title: "个人起点页示例",
    type: "file",
    routeId: "coding",
    description: "一个极小网页文件的占位入口，用来体验文件、代码和发布流程。",
    url: "/assets/digital-starter/examples/",
    status: "planned",
    tags: ["示例文件", "helloworld"],
    actionLabel: "下载",
  },
];

export const digitalStarterRoadmap = [
  "补充电脑基础文档",
  "补充 AI 做 PPT 示例",
  "补充 Markdown 与 GitHub 入门资料",
  "接入培训课件和下载文件",
];

export const digitalStarterUpdates: DigitalStarterUpdate[] = [
  {
    date: "2026-07-05",
    title: "创建三条路线骨架",
    description: "建立电脑、AI 和编程三条路线的入口页结构。",
  },
  {
    date: "2026-07-06",
    title: "预留资源接入结构",
    description: "整理 routes、resources、docs、assets 和 updates 数据集合。",
  },
  {
    date: "2026-07-06",
    title: "添加占位文档与资产入口",
    description: "为每条路线补充 2 到 3 个占位资源，验证后续接入方式。",
  },
];

export const digitalStarterConnectionNotes = [
  String(digitalStarterDocs.length) + " 个文档入口已预留",
  String(digitalStarterAssets.length) + " 类资产路径已预留",
  String(digitalStarterResources.length) + " 个资源占位从数据渲染",
];
