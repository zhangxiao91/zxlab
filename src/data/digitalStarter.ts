export type DigitalStarterRouteId = "computer" | "ai" | "coding";

export type DigitalStarterStatus =
  | "planned"
  | "draft"
  | "ready"
  | "writing"
  | "todo"
  | "pending"
  | "organizing";

export type DigitalStarterResourceType =
  | "link"
  | "document"
  | "asset"
  | "file"
  | "prompt"
  | "task";

export type DigitalStarterSoftwareToolType = "software" | "plugin" | "web" | "system";
export type DigitalStarterPublicStatus = "open" | "updating" | "soon";
export type DigitalStarterSoftwareLinkChannel =
  | "官网"
  | "Microsoft Store"
  | "扩展商店"
  | "官方支持";

export interface DigitalStarterSoftwareLink {
  label: string;
  url: string;
  channel: DigitalStarterSoftwareLinkChannel;
}

export interface DigitalStarterRoute {
  id: DigitalStarterRouteId;
  title: string;
  subtitle?: string;
  description: string;
  audience?: string[];
  modules: string[];
  status: DigitalStarterStatus;
  links: string[];
  assets: string[];
  docs: string[];
  resourceIds: string[];
  detailHref?: string;
  learningOutcome: string;
  durationLabel: string;
  publicStatus: DigitalStarterPublicStatus;
  actionLabel: string;
}

export interface DigitalStarterRouteModule {
  id: string;
  routeId: DigitalStarterRouteId;
  title: string;
  description: string;
  capabilities: string[];
  task: string;
  toolCategories?: string[];
  outcome: string;
  coreDocument: { title: string; href: string };
  practice: { title: string; href?: string };
  extension?: { title: string; href: string };
  duration: string;
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
  actionLabel: string;
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

export interface DigitalStarterTask {
  id: string;
  routeId: DigitalStarterRouteId;
  title: string;
  description: string;
  steps: string[];
  status: DigitalStarterStatus;
}

export interface DigitalStarterFeaturedResource {
  id: string;
  typeLabel: string;
  title: string;
  description: string;
  duration: string;
  publicStatus: DigitalStarterPublicStatus;
  href?: string;
  actionLabel: string;
}

export interface DigitalStarterSoftwareScenario {
  label: string;
  category: string;
  targetId: string;
}

export interface DigitalStarterWebsiteRecommendation {
  id: string;
  name: string;
  url: string;
  description: string;
  note?: string;
}

export interface DigitalStarterSoftwareTool {
  id: string;
  name: string;
  category: string;
  platform: string[];
  type: DigitalStarterSoftwareToolType;
  description: string;
  useCase: string;
  recommendedFor: string;
  officialLinks: DigitalStarterSoftwareLink[];
  alternatives?: string[];
  caution?: string;
  defaultChoice: string;
  optionalChoice: string;
  noInstallChoice: string;
  freeLabel: string;
  status: "ready" | "draft" | "todo";
  tags: string[];
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
  link: "链接",
  document: "文档",
  asset: "课件",
  file: "文件",
  prompt: "模板",
  task: "任务",
};

export const digitalStarterStatusLabels: Record<DigitalStarterStatus, string> = {
  planned: "即将开放",
  draft: "持续更新",
  ready: "已开放",
  writing: "持续更新",
  todo: "即将开放",
  pending: "即将开放",
  organizing: "持续更新",
};

export const digitalStarterPublicStatusLabels: Record<DigitalStarterPublicStatus, string> = {
  open: "已开放",
  updating: "持续更新",
  soon: "即将开放",
};

export const digitalStarterRoutes: DigitalStarterRoute[] = [
  {
    id: "computer",
    title: "电脑基础",
    subtitle: "从文件、快捷键、软件安装到跨设备同步，先把电脑用顺手。",
    description:
      "这条路线适合刚开始熟悉电脑的同学。它不会假设你已经懂很多术语，而是从最常见的真实场景开始：下载的文件去哪了、怎么截图、怎么解压、怎么安装和卸载软件、怎么整理大学资料、怎么让手机和电脑互传文件。",
    audience: ["刚拿到新电脑", "准备进入大学", "想先补齐电脑基础"],
    modules: ["电脑基础", "键盘与快捷键", "软件工具", "跨设备同步"],
    status: "draft",
    links: [],
    assets: ["college-folder-template"],
    docs: [
      "computer-basics",
      "keyboard-shortcuts-doc",
      "safe-download-guide",
      "file-structure-doc",
      "sync-plan-doc",
      "computer-help-prompt-doc",
      "software-toolbox",
    ],
    resourceIds: [
      "computer-basics",
      "keyboard-shortcuts-doc",
      "safe-download-guide",
      "college-folder-template",
      "screenshot-unzip-task",
      "sync-plan-doc",
      "computer-help-prompt",
      "software-toolbox",
    ],
    detailHref: "/lab/digital-starter/computer",
    learningOutcome: "学会管理文件、安装软件、截图解压，以及在手机和电脑之间同步资料。",
    durationLabel: "4 个模块 · 约 60 分钟",
    publicStatus: "open",
    actionLabel: "开始学习",
  },
  {
    id: "ai",
    title: "AI 提效",
    description: "适合想用 AI 辅助学习、整理资料、写作和制作展示内容的同学。",
    modules: ["AI 入门", "AI 做 PPT"],
    status: "draft",
    links: [],
    assets: ["ai-ppt-example-asset"],
    docs: ["ai-intro-doc"],
    resourceIds: ["ai-intro-doc", "ai-ppt-prompt", "ai-ppt-example-asset"],
    learningOutcome: "学会向 AI 提问、整理资料，并完成一次简单的 PPT 或学习任务。",
    durationLabel: "逐步开放",
    publicStatus: "updating",
    actionLabel: "查看路线",
  },
  {
    id: "coding",
    title: "编程入门",
    description:
      "适合对编程有一点好奇，想从文档、命令行、代码托管和 AI 辅助写代码开始体验的同学。",
    modules: ["Markdown", "helloworld", "命令行", "GitHub", "vibe coding"],
    status: "planned",
    links: ["github-example-repo"],
    assets: ["personal-start-page-file"],
    docs: ["markdown-start-doc"],
    resourceIds: ["markdown-start-doc", "github-example-repo", "personal-start-page-file"],
    learningOutcome: "从 Markdown、命令行和 GitHub 开始，完成第一次真正的编程体验。",
    durationLabel: "即将开放",
    publicStatus: "soon",
    actionLabel: "查看预告",
  },
];

export const digitalStarterRouteModules: DigitalStarterRouteModule[] = [
  {
    id: "computer-basics",
    routeId: "computer",
    title: "电脑与文件管理",
    description:
      "学会文件、文件夹、下载目录、软件安装、卸载、截图、压缩和解压。",
    capabilities: [
      "知道下载的文件通常在哪里",
      "能创建和整理文件夹",
      "能区分安装包、压缩包和软件本体",
      "能截图并标注",
      "能解压 zip / rar / 7z 文件",
      "能卸载不需要的软件",
      "能初步判断电脑卡顿、没网、没空间等常见问题",
    ],
    task: "整理一个“大学资料”文件夹，并完成一次截图、压缩和解压练习。",
    outcome: "学会创建、整理、查找、移动和备份文件。",
    coreDocument: { title: "电脑基础速查", href: "/lab/digital-starter/docs/computer-basics" },
    practice: { title: "完成截图、命名、压缩与解压", href: "/lab/digital-starter/docs/tasks" },
    extension: { title: "大学资料文件夹模板", href: "/lab/digital-starter/docs/file-structure" },
    duration: "15 分钟",
  },
  {
    id: "keyboard-shortcuts",
    routeId: "computer",
    title: "快捷键",
    description: "掌握最常用的键盘操作，让电脑用起来更顺手。",
    capabilities: [
      "复制、粘贴、剪切、撤销、保存",
      "全选、查找、重命名",
      "切换窗口和浏览器标签页",
      "使用 Windows / macOS 截图快捷键",
      "中英文输入法切换",
      "输入常见符号，例如 @、#、_、-、/、\\、:、;、\"、'",
    ],
    task: "用快捷键完成一段文字的复制、修改、保存、截图和文件重命名。",
    outcome: "用高频快捷键更快地编辑文字、切换窗口、截图和整理文件。",
    coreDocument: { title: "键盘快捷键清单", href: "/lab/digital-starter/docs/keyboard-shortcuts" },
    practice: { title: "只用快捷键完成一次保存与重命名" },
    extension: { title: "电脑问题求助模板", href: "/lab/digital-starter/docs/help-prompt" },
    duration: "10 分钟",
  },
  {
    id: "software-toolkit",
    routeId: "computer",
    title: "软件工具",
    description: "建立一套适合大学生活的基础软件工具箱，不追求装得多，先覆盖真实需求。",
    capabilities: [
      "从官网或可信来源下载软件",
      "识别假下载按钮和捆绑安装",
      "能管理浏览器插件",
      "了解播放器、压缩工具、截图工具、文件搜索、笔记工具和密码管理器的作用",
      "定期清理不用的软件",
      "知道软件更新、开机自启动和默认打开方式的基本概念",
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
    task: "建立自己的“常用软件清单”，每类最多选择 1 到 2 个工具。",
    outcome: "能按真实需求选择软件，并从官方来源安全下载和安装。",
    coreDocument: { title: "推荐软件与插件", href: "/lab/digital-starter/docs/software-toolbox" },
    practice: { title: "从官网找到并检查一个安装包", href: "/lab/digital-starter/docs/safe-download" },
    extension: { title: "安全下载软件指南", href: "/lab/digital-starter/docs/safe-download" },
    duration: "20 分钟",
  },
  {
    id: "device-sync",
    routeId: "computer",
    title: "跨设备同步",
    description: "让手机、电脑和平板之间可以稳定传文件、同步资料和备份重要内容。",
    capabilities: [
      "区分临时传输和长期同步",
      "理解云盘、本地文件和备份之间的关系",
      "知道微信文件传输助手、iCloud、OneDrive、网盘、AirDrop、Nearby Share 等方案适合什么场景",
      "知道同步冲突、误删同步、文件过期等风险",
      "能备份证件、录取资料、课程资料和项目文件",
      "不把敏感资料随便上传到陌生平台",
    ],
    task: "设计自己的多设备同步方案，至少包含“临时传输”“长期同步”“重要资料备份”三类。",
    outcome: "分清传输、同步和备份，为手机与电脑选择合适的资料流转方式。",
    coreDocument: { title: "跨设备同步入门", href: "/lab/digital-starter/docs/device-sync" },
    practice: { title: "写下自己的三层同步与备份方案" },
    extension: { title: "大学资料文件夹模板", href: "/lab/digital-starter/docs/file-structure" },
    duration: "15 分钟",
  },
];

export const digitalStarterDocs: DigitalStarterDoc[] = [
  {
    id: "computer-basics",
    title: "电脑基础速查表",
    routeId: "computer",
    description: "面向准大学生的 Windows 电脑基础操作小抄。",
    path: "/lab/digital-starter/docs/computer-basics",
    status: "draft",
    updatedAt: "2026-07-08",
  },
  {
    id: "keyboard-shortcuts-doc",
    title: "键盘快捷键清单",
    routeId: "computer",
    description: "收集 Windows 和 macOS 最常用快捷键，适合新手反复查看。",
    path: "/lab/digital-starter/docs/keyboard-shortcuts",
    status: "draft",
    updatedAt: "2026-07-08",
  },
  {
    id: "safe-download-guide",
    title: "安全下载软件指南",
    routeId: "computer",
    description: "说明如何找到官网、识别假下载按钮、避免捆绑安装和恶意软件。",
    path: "/lab/digital-starter/docs/safe-download",
    status: "draft",
    updatedAt: "2026-07-08",
  },
  {
    id: "file-structure-doc",
    title: "大学资料文件夹模板",
    routeId: "computer",
    description: "给课程、作业、证件、项目、临时下载和归档备份预留一套清晰结构。",
    path: "/lab/digital-starter/docs/file-structure",
    status: "draft",
    updatedAt: "2026-07-08",
  },
  {
    id: "sync-plan-doc",
    title: "跨设备同步方案",
    routeId: "computer",
    description: "介绍手机、电脑、平板之间传文件、同步和备份的基本方案。",
    path: "/lab/digital-starter/docs/device-sync",
    status: "draft",
    updatedAt: "2026-07-08",
  },
  {
    id: "computer-help-prompt-doc",
    title: "电脑问题求助模板",
    routeId: "computer",
    description: "把报错、截图、设备信息和已经尝试过的方法整理清楚，再去求助。",
    path: "/lab/digital-starter/docs/help-prompt",
    status: "draft",
    updatedAt: "2026-07-08",
  },
  {
    id: "software-toolbox",
    title: "推荐插件与软件列表",
    routeId: "computer",
    description: "给准大学生的 Windows 基础工具箱。",
    path: "/lab/digital-starter/docs/software-toolbox",
    status: "draft",
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
    description: "提供一套适合大学新生的文件夹结构示例，用于整理课程、作业、证件、项目和临时下载。",
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
    id: "computer-basics",
    title: "电脑基础速查表",
    type: "document",
    routeId: "computer",
    description: "整理文件夹、下载目录、截图、解压、软件安装和卸载等基础操作。",
    url: "/lab/digital-starter/docs/computer-basics",
    status: "draft",
    tags: ["Windows", "电脑基础", "文件管理", "截图", "解压"],
    actionLabel: "查看文档",
  },
  {
    id: "keyboard-shortcuts-doc",
    title: "键盘快捷键清单",
    type: "document",
    routeId: "computer",
    description: "收集 Windows 和 macOS 最常用快捷键，适合新手反复查看。",
    url: "/lab/digital-starter/docs/keyboard-shortcuts",
    status: "draft",
    tags: ["文档", "快捷键"],
    actionLabel: "查看清单",
  },
  {
    id: "safe-download-guide",
    title: "安全下载软件指南",
    type: "document",
    routeId: "computer",
    description: "说明如何找到官网、识别假下载按钮、避免捆绑安装和恶意软件。",
    url: "/lab/digital-starter/docs/safe-download",
    status: "draft",
    tags: ["文档", "软件工具"],
    actionLabel: "查看指南",
  },
  {
    id: "college-folder-template",
    title: "大学资料文件夹模板",
    type: "file",
    routeId: "computer",
    description: "提供一套适合大学新生的文件夹结构示例，用于整理课程、作业、证件、项目和临时下载。",
    url: "/lab/digital-starter/docs/file-structure",
    status: "pending",
    tags: ["示例文件", "文件管理"],
    actionLabel: "查看使用说明",
  },
  {
    id: "screenshot-unzip-task",
    title: "完成一次截图、压缩和解压",
    type: "task",
    routeId: "computer",
    description: "通过一个小任务练习截图、标注、压缩和解压。",
    url: "/lab/digital-starter/docs/tasks",
    status: "draft",
    tags: ["任务", "文件管理"],
    actionLabel: "查看任务",
  },
  {
    id: "sync-plan-doc",
    title: "跨设备同步方案",
    type: "document",
    routeId: "computer",
    description: "介绍手机、电脑、平板之间传文件、同步和备份的基本方案。",
    url: "/lab/digital-starter/docs/device-sync",
    status: "draft",
    tags: ["文档", "同步备份"],
    actionLabel: "查看方案",
  },
  {
    id: "computer-help-prompt",
    title: "电脑问题求助模板",
    type: "prompt",
    routeId: "computer",
    description: "教新手把“电脑出问题了”描述清楚，方便向同学、搜索引擎或 AI 求助。",
    url: "/lab/digital-starter/docs/help-prompt",
    status: "draft",
    tags: ["求助模板", "求助"],
    actionLabel: "复制模板",
  },
  {
    id: "software-toolbox",
    title: "推荐插件与软件列表",
    type: "document",
    routeId: "computer",
    description: "按浏览器、广告过滤、视频播放、压缩解压、截图录屏、笔记、同步和安全等类别整理常用工具。",
    url: "/lab/digital-starter/docs/software-toolbox",
    status: "draft",
    tags: ["Windows", "软件工具", "浏览器插件", "工具箱"],
    actionLabel: "查看列表",
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

export const digitalStarterFeaturedResources: DigitalStarterFeaturedResource[] = [
  {
    id: "computer-basics",
    typeLabel: "文档",
    title: "电脑基础速查",
    description: "快速找到文件、截图、解压，并处理常见电脑小问题。",
    duration: "阅读约 12 分钟",
    publicStatus: "open",
    href: "/lab/digital-starter/docs/computer-basics",
    actionLabel: "打开文档",
  },
  {
    id: "software-toolbox",
    typeLabel: "工具清单",
    title: "推荐软件与插件",
    description: "按使用场景选择真正需要的软件，并从官方入口获取。",
    duration: "浏览约 10 分钟",
    publicStatus: "open",
    href: "/lab/digital-starter/docs/software-toolbox",
    actionLabel: "查看清单",
  },
  {
    id: "screenshot-unzip-task",
    typeLabel: "实战任务",
    title: "截图与解压练习",
    description: "完成一次截图、规范命名、压缩和重新解压。",
    duration: "完成约 10 分钟",
    publicStatus: "open",
    href: "/lab/digital-starter/docs/tasks",
    actionLabel: "开始任务",
  },
  {
    id: "safe-download-guide",
    typeLabel: "文档",
    title: "安全下载软件指南",
    description: "识别官网、假下载按钮、高速下载器和捆绑安装。",
    duration: "阅读约 8 分钟",
    publicStatus: "open",
    href: "/lab/digital-starter/docs/safe-download",
    actionLabel: "查看指南",
  },
  {
    id: "sync-plan-doc",
    typeLabel: "文档",
    title: "跨设备同步入门",
    description: "分清临时传输、长期同步和重要资料备份。",
    duration: "阅读约 10 分钟",
    publicStatus: "open",
    href: "/lab/digital-starter/docs/device-sync",
    actionLabel: "开始阅读",
  },
  {
    id: "ai-ppt-intro",
    typeLabel: "学习任务",
    title: "AI 做 PPT 入门",
    description: "把资料整理成结构清楚的展示大纲和页面计划。",
    duration: "预计 20 分钟",
    publicStatus: "soon",
    actionLabel: "即将开放",
  },
];

export const digitalStarterTasks: DigitalStarterTask[] = [
  {
    id: "organize-college-folder",
    routeId: "computer",
    title: "整理大学资料文件夹",
    description: "新建一个总文件夹，并用固定结构收纳课程、作业、证件、项目和临时下载。",
    steps: ["课程资料", "作业与实验", "证件材料", "项目作品", "临时下载", "归档备份"],
    status: "todo",
  },
  {
    id: "screenshot-zip-unzip",
    routeId: "computer",
    title: "完成一次截图、压缩和解压",
    description: "截一张图，保存到指定文件夹，把它压缩成 zip，再解压到另一个文件夹。",
    steps: ["完成截图", "保存到指定文件夹", "压缩成 zip", "解压到另一个文件夹"],
    status: "draft",
  },
  {
    id: "software-shortlist",
    routeId: "computer",
    title: "建立常用软件清单",
    description:
      "为浏览器、截图、压缩、播放器、笔记、PDF、同步和密码管理各选一个工具，写下用途和下载来源。",
    steps: ["选择工具类别", "记录工具用途", "记录下载来源", "删除暂时不用的软件"],
    status: "organizing",
  },
];

export const digitalStarterSoftwareCategories = [
  "浏览器与插件",
  "浏览器插件",
  "AI 与工作台",
  "广告过滤",
  "输入法",
  "视频播放",
  "压缩解压",
  "截图与录屏",
  "文件搜索与管理",
  "文档与 PDF",
  "笔记与 Markdown",
  "同步与备份",
  "远程桌面与屏幕",
  "密码与账号安全",
  "编程入门",
  "系统效率工具",
];

export const digitalStarterSoftwareScenarios: DigitalStarterSoftwareScenario[] = [
  { label: "翻译和控制视频速度", category: "浏览器插件", targetId: "software-browser-plugins" },
  { label: "打开压缩包", category: "压缩解压", targetId: "software-archive" },
  { label: "找不到文件", category: "文件搜索与管理", targetId: "software-search" },
  { label: "截图和录屏", category: "截图与录屏", targetId: "software-capture" },
  { label: "管理输入法", category: "输入法", targetId: "software-input" },
  { label: "写作业和做 PPT", category: "文档与 PDF", targetId: "software-office" },
  { label: "同步手机与电脑", category: "同步与备份", targetId: "software-sync" },
  { label: "远程控制屏幕", category: "远程桌面与屏幕", targetId: "software-remote" },
  { label: "管理密码", category: "密码与账号安全", targetId: "software-password" },
  { label: "开始编程", category: "编程入门", targetId: "software-code" },
];

export const digitalStarterSoftwareTools: DigitalStarterSoftwareTool[] = [
  {
    id: "browser-basics",
    name: "Microsoft Edge / Chrome / Firefox",
    category: "浏览器与插件",
    platform: ["Windows", "macOS", "Mobile"],
    type: "software",
    description: "常用浏览器，用于搜索资料、访问课程平台、管理书签和下载文件。",
    useCase: "日常搜索、课程平台、资料下载、账号登录和书签管理。",
    recommendedFor: "所有刚开始管理电脑和学习资料的同学。",
    officialLinks: [
      { label: "Microsoft Edge", url: "https://www.microsoft.com/edge/download", channel: "官网" },
      { label: "Google Chrome", url: "https://www.google.com/chrome/", channel: "官网" },
      { label: "Mozilla Firefox", url: "https://www.mozilla.org/firefox/new/", channel: "官网" },
    ],
    alternatives: ["Safari"],
    caution: "登录重要账号时看清网址，浏览器插件不要乱装。",
    defaultChoice: "Microsoft Edge",
    optionalChoice: "Chrome 或 Firefox",
    noInstallChoice: "Windows 已自带 Edge，可以先直接使用。",
    freeLabel: "免费",
    status: "draft",
    tags: ["Browser", "书签", "下载"],
  },
  {
    id: "immersive-translate",
    name: "沉浸式翻译",
    category: "浏览器插件",
    platform: ["Windows", "macOS", "Browser"],
    type: "plugin",
    description: "在网页、PDF、视频字幕等场景提供双语或辅助翻译，适合阅读英文资料。",
    useCase: "阅读课程资料、技术文档、论文摘要和外文网页。",
    recommendedFor: "需要经常阅读英文网页或 PDF，但不想每段文字都手动复制翻译的同学。",
    officialLinks: [
      {
        label: "沉浸式翻译官方站",
        url: "https://immersivetranslate.com/",
        channel: "官网",
      },
      {
        label: "Chrome 扩展商店",
        url: "https://chromewebstore.google.com/detail/immersive-translate-ai-we/bpoadfkcbjbfhfodiogcnhhhpibjhbnh",
        channel: "扩展商店",
      },
    ],
    alternatives: ["浏览器自带翻译", "手动复制到可信翻译工具"],
    caution: "翻译结果只能作为辅助理解；处理未公开资料、账号信息或敏感文档前，先确认扩展权限和数据处理方式。",
    defaultChoice: "先在公开网页上试用双语阅读",
    optionalChoice: "需要 PDF 或视频字幕翻译时再深入配置",
    noInstallChoice: "偶尔查一个单词时，浏览器自带翻译就够用。",
    freeLabel: "提供免费功能，具体以官方说明为准",
    status: "draft",
    tags: ["插件", "翻译", "PDF", "双语阅读"],
  },
  {
    id: "global-speed",
    name: "Global Speed",
    category: "浏览器插件",
    platform: ["Windows", "macOS", "Browser"],
    type: "plugin",
    description: "统一控制网页音视频的播放速度、快进、后退和部分播放参数。",
    useCase: "观看课程、讲座、访谈和长视频时调整播放速度。",
    recommendedFor: "经常看在线课程，希望用快捷键控制不同网站播放速度的同学。",
    officialLinks: [
      {
        label: "Global Speed（Chrome）",
        url: "https://chromewebstore.google.com/detail/global-speed-video-speed/jpbjcnkcffbooppibceonlgknpkniiff",
        channel: "扩展商店",
      },
      {
        label: "Global Speed（Firefox）",
        url: "https://addons.mozilla.org/en-GB/firefox/addon/global-speed/",
        channel: "扩展商店",
      },
    ],
    alternatives: ["网站自带播放速度设置", "系统媒体快捷键"],
    caution: "插件需要读取或控制部分网页媒体；只从官方扩展商店安装，不要为了倍速播放安装来路不明的脚本。",
    defaultChoice: "先使用网站自带的 1.25x / 1.5x 速度",
    optionalChoice: "需要跨网站统一控制时再安装 Global Speed",
    noInstallChoice: "只看短视频或很少调整速度时，不需要安装。",
    freeLabel: "免费",
    status: "draft",
    tags: ["插件", "视频", "播放速度"],
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    category: "AI 与工作台",
    platform: ["Windows", "macOS", "Web"],
    type: "software",
    description: "腾讯的 AI 工作台，可以把资料整理、检索和生成文件等任务交给 AI 协助完成。",
    useCase: "整理资料、做调研、生成文档和处理重复性工作。",
    recommendedFor: "想尝试 AI 辅助完成具体任务，但还不想自己搭建复杂工具的同学。",
    officialLinks: [
      { label: "WorkBuddy 官方入口", url: "https://www.workbuddy.cn/", channel: "官网" },
    ],
    alternatives: ["先使用现有 AI 聊天工具", "Windows 自带文件和搜索功能"],
    caution: "使用前确认上传内容不包含密码、验证码、身份证号或未公开的敏感资料；生成结果仍需要自己核对。",
    defaultChoice: "先从 WorkBuddy 的一个具体任务开始",
    optionalChoice: "熟悉 AI 工作流后再探索更多工具",
    noInstallChoice: "只是问一个简单问题时，不需要额外安装 AI 工作台。",
    freeLabel: "以官方说明为准",
    status: "draft",
    tags: ["AI", "工作台", "资料整理"],
  },
  {
    id: "ad-blocking",
    name: "uBlock Origin / AdGuard",
    category: "广告过滤",
    platform: ["Windows", "macOS", "Browser"],
    type: "plugin",
    description: "用于减少网页广告和部分追踪，提高浏览体验。",
    useCase: "浏览资料页、论坛和下载页时减少干扰。",
    recommendedFor: "经常查资料、阅读网页和访问课程站点的同学。",
    officialLinks: [
      {
        label: "uBlock Origin（Firefox）",
        url: "https://addons.mozilla.org/firefox/addon/ublock-origin/",
        channel: "扩展商店",
      },
      {
        label: "uBlock Origin Lite（Chrome）",
        url: "https://chromewebstore.google.com/detail/ublock-origin-lite/ddkjiahejlhfcafbddmgiahcphecmpfh",
        channel: "扩展商店",
      },
      {
        label: "AdGuard 浏览器扩展",
        url: "https://adguard.com/adguard-browser-extension/overview.html",
        channel: "官网",
      },
    ],
    alternatives: ["浏览器内置跟踪防护"],
    caution: "插件权限较高，优先从浏览器官方扩展商店安装。Chrome 使用 uBlock Origin Lite，Firefox 可使用完整 uBlock Origin。",
    defaultChoice: "uBlock Origin Lite（Chrome）或 uBlock Origin（Firefox）",
    optionalChoice: "AdGuard 浏览器扩展",
    noInstallChoice: "如果很少遇到广告干扰，可以先用浏览器自带防护。",
    freeLabel: "均有免费版本",
    status: "draft",
    tags: ["Plugin", "广告过滤", "Browser"],
  },
  {
    id: "wechat-input",
    name: "微信输入法",
    category: "输入法",
    platform: ["Windows", "macOS", "Mobile"],
    type: "software",
    description: "腾讯提供的输入法，支持拼音、语音和常用词输入。",
    useCase: "日常聊天、写作业、中文输入和跨设备使用输入习惯。",
    recommendedFor: "想换一套界面简单、中文输入为主的输入法的同学。",
    officialLinks: [
      {
        label: "微信输入法（Microsoft Store）",
        url: "https://apps.microsoft.com/detail/XPFFFP686NDRDZ?hl=zh-CN&gl=CN",
        channel: "Microsoft Store",
      },
    ],
    alternatives: ["微软拼音", "系统自带输入法"],
    caution: "安装后检查云同步、剪贴板、语音和个性化推荐等权限，敏感内容不要随意输入或同步。",
    defaultChoice: "先使用 Windows 自带微软拼音",
    optionalChoice: "需要时再试微信输入法",
    noInstallChoice: "Windows 自带输入法已经够用，不必为了跟风安装。",
    freeLabel: "免费",
    status: "draft",
    tags: ["输入法", "拼音", "语音"],
  },
  {
    id: "doubao-input",
    name: "豆包输入法",
    category: "输入法",
    platform: ["Windows", "macOS", "Mobile"],
    type: "software",
    description: "提供拼音、语音和智能输入能力的第三方输入法。",
    useCase: "中文输入、语音转文字和需要智能候选词的场景。",
    recommendedFor: "想体验语音输入或 AI 辅助输入的同学。",
    officialLinks: [
      { label: "豆包输入法官方站", url: "https://srf.doubao.com/", channel: "官网" },
    ],
    alternatives: ["微软拼音", "微信输入法"],
    caution: "输入法可能接触你输入的文字、剪贴板或语音，安装和启用前先看清权限与隐私说明。",
    defaultChoice: "先用系统输入法，确有需求再试豆包输入法",
    optionalChoice: "需要语音或智能候选时再启用",
    noInstallChoice: "只做普通文字输入时，不需要额外安装。",
    freeLabel: "以官方说明为准",
    status: "draft",
    tags: ["输入法", "语音", "AI"],
  },
  {
    id: "video-player",
    name: "PotPlayer / VLC",
    category: "视频播放",
    platform: ["Windows", "macOS"],
    type: "software",
    description: "用于播放本地视频、课程录像和多种格式的视频文件。",
    useCase: "打开下载到电脑里的课程录像、讲座视频和常见视频格式。",
    recommendedFor: "需要保存网课录像或经常看本地视频文件的同学。",
    officialLinks: [
      { label: "VLC media player", url: "https://www.videolan.org/vlc/", channel: "官网" },
      { label: "PotPlayer", url: "https://potplayer.daum.net/", channel: "官网" },
    ],
    alternatives: ["系统自带播放器"],
    caution: "优先从官网或可信来源下载。",
    defaultChoice: "VLC media player",
    optionalChoice: "Windows 用户也可以选择 PotPlayer",
    noInstallChoice: "普通 MP4 视频先用系统自带播放器。",
    freeLabel: "免费",
    status: "draft",
    tags: ["视频", "课程录像"],
  },
  {
    id: "archive-tools",
    name: "7-Zip / Bandizip",
    category: "压缩解压",
    platform: ["Windows", "macOS"],
    type: "software",
    description: "用于解压 zip、rar、7z 等压缩包，也可以把多个文件打包发送。",
    useCase: "处理老师、同学或网站提供的压缩包，整理多个文件后统一发送。",
    recommendedFor: "需要交作业、收课件、下载资料包的新生。",
    officialLinks: [
      { label: "7-Zip", url: "https://www.7-zip.org/download.html", channel: "官网" },
      { label: "Bandizip", url: "https://www.bandisoft.com/bandizip/", channel: "官网" },
    ],
    alternatives: ["系统自带压缩功能"],
    caution: "安装时留意是否有额外推荐软件。",
    defaultChoice: "7-Zip",
    optionalChoice: "Bandizip",
    noInstallChoice: "只处理 ZIP 时，可以先使用 Windows 自带解压功能。",
    freeLabel: "7-Zip 免费；Bandizip 提供免费版",
    status: "draft",
    tags: ["zip", "rar", "7z"],
  },
  {
    id: "screenshot-recording",
    name: "Windows 自带截图 / Snipaste / ShareX",
    category: "截图与录屏",
    platform: ["Windows"],
    type: "software",
    description: "用于截图、标注、保存问题现场或制作简单说明图。",
    useCase: "记录报错、截取资料、标注问题位置和制作简单说明。",
    recommendedFor: "所有需要写作业、求助或整理资料的同学。",
    officialLinks: [
      {
        label: "Windows 截图工具",
        url: "https://apps.microsoft.com/detail/9MZ95KL8MR0L",
        channel: "Microsoft Store",
      },
      { label: "Snipaste", url: "https://www.snipaste.com/", channel: "官网" },
      { label: "ShareX", url: "https://getsharex.com/", channel: "官网" },
    ],
    alternatives: ["macOS 截图工具"],
    caution: "新手先熟悉 Win + Shift + S，再考虑安装额外工具。",
    defaultChoice: "Windows 截图工具",
    optionalChoice: "Snipaste；需要复杂录屏时再看 ShareX",
    noInstallChoice: "系统工具已经足够完成日常截图。",
    freeLabel: "免费",
    status: "draft",
    tags: ["截图", "录屏", "标注"],
  },
  {
    id: "everything-search",
    name: "Everything",
    category: "文件搜索与管理",
    platform: ["Windows"],
    type: "software",
    description: "用于在 Windows 上快速搜索文件，适合找不到下载文件或资料时使用。",
    useCase: "按文件名快速找下载、课件、截图和临时保存的资料。",
    recommendedFor: "经常找不到文件位置的同学。",
    officialLinks: [
      { label: "Everything", url: "https://www.voidtools.com/downloads/", channel: "官网" },
    ],
    alternatives: ["Windows 搜索"],
    caution: "第一次使用需要建立索引，搜索结果要看清文件所在路径。",
    defaultChoice: "Everything",
    optionalChoice: "Windows 搜索",
    noInstallChoice: "如果文件夹命名清楚，先用系统搜索即可。",
    freeLabel: "免费",
    status: "draft",
    tags: ["文件搜索", "Windows"],
  },
  {
    id: "office-pdf",
    name: "WPS / Microsoft Office / PDF Reader",
    category: "文档与 PDF",
    platform: ["Windows", "macOS", "Mobile"],
    type: "software",
    description: "用于处理作业、报告、PPT、表格和 PDF 阅读批注。",
    useCase: "写报告、做 PPT、看论文或阅读课程 PDF。",
    recommendedFor: "需要提交文档、表格、PPT 和 PDF 作业的同学。",
    officialLinks: [
      { label: "WPS Office", url: "https://www.wps.cn/", channel: "官网" },
      { label: "Microsoft 365", url: "https://www.microsoft.com/zh-cn/microsoft-365", channel: "官网" },
      { label: "Adobe Acrobat Reader", url: "https://get.adobe.com/cn/reader/", channel: "官网" },
    ],
    alternatives: ["LibreOffice", "浏览器 PDF 阅读器"],
    caution: "注意文件格式兼容，提交作业前确认格式要求。",
    defaultChoice: "学校提供的 Microsoft 365 或 WPS Office",
    optionalChoice: "Adobe Acrobat Reader 用于阅读和批注 PDF",
    noInstallChoice: "只查看 PDF 时，浏览器通常已经够用。",
    freeLabel: "WPS 和 Reader 有免费版；Microsoft 365 以学校授权为准",
    status: "draft",
    tags: ["PDF", "PPT", "Office"],
  },
  {
    id: "markdown-notes",
    name: "Obsidian / Typora / VS Code",
    category: "笔记与 Markdown",
    platform: ["Windows", "macOS"],
    type: "software",
    description: "用于写笔记、Markdown 文档、说明文件和简单网页内容。",
    useCase: "整理课程笔记、项目说明、学习记录和 Markdown 文档。",
    recommendedFor: "想把笔记和资料整理得更清楚的同学。",
    officialLinks: [
      { label: "Obsidian", url: "https://obsidian.md/download", channel: "官网" },
      { label: "Typora", url: "https://typora.io/", channel: "官网" },
      { label: "Visual Studio Code", url: "https://code.visualstudio.com/Download", channel: "官网" },
    ],
    alternatives: ["Notion", "系统备忘录"],
    caution: "新手可以先从 Markdown 标题、列表、链接和代码块开始。",
    defaultChoice: "Obsidian",
    optionalChoice: "Typora 或 Visual Studio Code",
    noInstallChoice: "偶尔记录文字时，系统记事本就够用。",
    freeLabel: "Obsidian 个人使用免费；Typora 付费；VS Code 免费",
    status: "draft",
    tags: ["Markdown", "笔记", "VS Code"],
  },
  {
    id: "sync-backup",
    name: "OneDrive / iCloud / 坚果云 / 百度网盘",
    category: "同步与备份",
    platform: ["Windows", "macOS", "Web", "Mobile"],
    type: "software",
    description: "用于在电脑、手机和平板之间同步资料或备份重要文件。",
    useCase: "同步课程资料、备份证件材料、跨设备传文件。",
    recommendedFor: "有多台设备或担心重要资料丢失的同学。",
    officialLinks: [
      {
        label: "Microsoft OneDrive",
        url: "https://support.microsoft.com/onedrive/download-onedrive",
        channel: "官方支持",
      },
      {
        label: "Windows 版 iCloud",
        url: "https://apps.microsoft.com/detail/9PKTQ5699M62",
        channel: "Microsoft Store",
      },
      { label: "坚果云", url: "https://www.jianguoyun.com/s/downloads", channel: "官网" },
      { label: "百度网盘", url: "https://pan.baidu.com/download", channel: "官网" },
    ],
    alternatives: ["移动硬盘", "U 盘"],
    caution: "同步不等于备份，误删可能会同步到其他设备。",
    defaultChoice: "OneDrive（Windows）或 iCloud（苹果设备）",
    optionalChoice: "坚果云、百度网盘或移动硬盘",
    noInstallChoice: "只临时传一个文件时，可以使用微信文件传输助手。",
    freeLabel: "均提供基础免费空间，容量和功能以官方说明为准",
    status: "draft",
    tags: ["OneDrive", "iCloud", "备份"],
  },
  {
    id: "sunlogin",
    name: "向日葵远程控制",
    category: "远程桌面与屏幕",
    platform: ["Windows", "macOS", "Mobile"],
    type: "software",
    description: "用于远程控制电脑、查看屏幕和传输文件的远程桌面工具。",
    useCase: "远程协助家人、从另一台设备查看电脑和临时取用文件。",
    recommendedFor: "确实需要远程控制自己或获得明确授权的电脑的同学。",
    officialLinks: [
      { label: "向日葵官方下载", url: "https://sunlogin.oray.com/download", channel: "官网" },
    ],
    alternatives: ["Windows 快速助手", "UU 远程"],
    caution: "远程控制涉及屏幕、文件和设备权限，只连接自己或明确授权的设备，使用后关闭不需要的无人值守和开机自启。",
    defaultChoice: "临时协助时再安装向日葵",
    optionalChoice: "需要长期远控时再配置固定设备",
    noInstallChoice: "不需要远程控制时不要安装或常驻。",
    freeLabel: "提供免费功能，具体以官方说明为准",
    status: "draft",
    tags: ["远程控制", "文件传输", "屏幕"],
  },
  {
    id: "uu-remote",
    name: "UU 远程",
    category: "远程桌面与屏幕",
    platform: ["Windows", "macOS", "Mobile"],
    type: "software",
    description: "用于远程控制、文件传输和低延迟游戏串流的跨设备工具。",
    useCase: "远程办公、从手机控制电脑、传文件或串流使用电脑上的游戏和应用。",
    recommendedFor: "明确需要跨设备远程控制或游戏串流的用户。",
    officialLinks: [
      { label: "UU 远程官方下载", url: "https://uuyc163.com/download/", channel: "官网" },
    ],
    alternatives: ["向日葵远程控制", "Moonlight"],
    caution: "远程控制涉及屏幕、文件和设备权限；只使用官方入口，连接前确认设备和授权对象，使用后检查后台常驻状态。",
    defaultChoice: "需要远程控制和文件传输时再安装",
    optionalChoice: "游戏串流场景可进一步比较 Moonlight",
    noInstallChoice: "普通文件同步不需要远程控制软件。",
    freeLabel: "以官方说明为准",
    status: "draft",
    tags: ["远程控制", "文件传输", "游戏串流"],
  },
  {
    id: "moonlight",
    name: "Moonlight",
    category: "远程桌面与屏幕",
    platform: ["Windows", "macOS", "Linux", "Mobile"],
    type: "software",
    description: "开源游戏串流客户端，通常需要搭配 Sunshine 等主机端使用。",
    useCase: "把电脑画面和游戏串流到另一台电脑、手机、平板或电视。",
    recommendedFor: "已经了解主机端、网络和账号配对，希望体验低延迟串流的用户。",
    officialLinks: [
      { label: "Moonlight 官方发行页", url: "https://github.com/moonlight-stream/moonlight-qt/releases", channel: "官网" },
    ],
    alternatives: ["UU 远程", "Steam Link"],
    caution: "Moonlight 是客户端，配置网络和主机端时仍需确认访问权限；不要把远程端口和账号凭据随意公开。",
    defaultChoice: "只在明确需要游戏串流时使用",
    optionalChoice: "先从 Steam Link 或 UU 远程开始体验",
    noInstallChoice: "不玩远程串流时不需要安装。",
    freeLabel: "开源免费",
    status: "draft",
    tags: ["远程控制", "游戏串流", "开源"],
  },
  {
    id: "password-manager",
    name: "Bitwarden / 1Password",
    category: "密码与账号安全",
    platform: ["Windows", "macOS", "Web", "Mobile"],
    type: "software",
    description: "用于管理多个账号密码，减少重复使用弱密码的风险。",
    useCase: "保存课程平台、邮箱、GitHub 和常用网站账号。",
    recommendedFor: "开始拥有多个学习、生活和工具账号的同学。",
    officialLinks: [
      { label: "Bitwarden", url: "https://bitwarden.com/download/", channel: "官网" },
      { label: "1Password", url: "https://1password.com/downloads/", channel: "官网" },
    ],
    alternatives: ["浏览器密码管理器"],
    caution: "主密码一定要记牢，重要账号建议开启两步验证。",
    defaultChoice: "Bitwarden",
    optionalChoice: "1Password",
    noInstallChoice: "账号不多时，可以先使用浏览器密码管理器。",
    freeLabel: "Bitwarden 有免费版；1Password 付费",
    status: "draft",
    tags: ["密码管理", "账号安全"],
  },
  {
    id: "vscode-intro",
    name: "VS Code",
    category: "编程入门",
    platform: ["Windows", "macOS"],
    type: "software",
    description: "代码编辑器，也可以写 Markdown、HTML 和简单项目。",
    useCase: "打开文件夹、编辑代码、预览 HTML、写 Markdown。",
    recommendedFor: "对编程、网页或 AI 辅助写代码有兴趣的同学。",
    officialLinks: [
      { label: "Visual Studio Code", url: "https://code.visualstudio.com/Download", channel: "官网" },
    ],
    alternatives: ["Cursor", "系统文本编辑器"],
    caution: "第一次使用先学会打开文件夹、编辑文件和预览 HTML。",
    defaultChoice: "Visual Studio Code",
    optionalChoice: "熟悉基础后再考虑其他编辑器",
    noInstallChoice: "还没准备开始编程时，不需要提前安装。",
    freeLabel: "免费",
    status: "draft",
    tags: ["VS Code", "编程", "Markdown"],
  },
  {
    id: "powertoys",
    name: "PowerToys",
    category: "系统效率工具",
    platform: ["Windows"],
    type: "system",
    description: "微软提供的 Windows 效率工具合集，包含窗口管理、批量重命名、颜色拾取等功能。",
    useCase: "进阶窗口管理、批量整理文件名、屏幕取色和快捷启动。",
    recommendedFor: "已经熟悉基础操作，想继续提升 Windows 效率的同学。",
    officialLinks: [
      {
        label: "PowerToys",
        url: "https://apps.microsoft.com/detail/XP89DCGQ3K6VLD",
        channel: "Microsoft Store",
      },
      {
        label: "安装说明",
        url: "https://learn.microsoft.com/zh-cn/windows/powertoys/install",
        channel: "官方支持",
      },
    ],
    alternatives: ["Windows 自带设置"],
    caution: "新手可以先不用急着装，熟悉基础操作后再探索。",
    defaultChoice: "暂时无需安装",
    optionalChoice: "需要批量重命名或窗口管理时再安装 PowerToys",
    noInstallChoice: "先把 Windows 自带快捷键和设置用熟。",
    freeLabel: "免费",
    status: "draft",
    tags: ["Windows", "效率工具"],
  },
];

export const digitalStarterWebsiteRecommendations: DigitalStarterWebsiteRecommendation[] = [
  {
    id: "monkeytype",
    name: "Monkeytype",
    url: "https://monkeytype.com/",
    description: "简洁、可自定义的打字练习网站，适合用短时间练习英文输入速度和准确率。",
  },
  {
    id: "vscode-web",
    name: "VS Code for the Web",
    url: "https://vscode.dev/",
    description: "直接在浏览器里打开的 VS Code 编辑器，适合快速查看或修改代码和 Markdown。",
    note: "它不是完整桌面开发环境，复杂项目仍需要本地工具或远程开发环境。",
  },
  {
    id: "linux-do",
    name: "Linux.do",
    url: "https://linux.do/",
    description: "面向 Linux、开发工具和 AI 等主题的技术社区，适合搜索经验和参与讨论。",
    note: "社区经验需要结合自己的系统版本和官方文档核对。",
  },
  {
    id: "v2ex",
    name: "V2EX",
    url: "https://www.v2ex.com/",
    description: "以技术、产品和互联网生活为主题的社区，适合观察真实用户讨论和工具经验。",
    note: "论坛回复不等于官方结论，涉及安全、账号和付费服务时要回到产品官网确认。",
  },
  {
    id: "stackoverflow",
    name: "Stack Overflow",
    url: "https://stackoverflow.com/",
    description: "英文编程问答网站，适合把报错文字、代码片段和环境信息放在一起检索。",
    note: "优先查看高票答案的更新时间，并确认答案适用于当前版本。",
  },
  {
    id: "cyberchef",
    name: "CyberChef",
    url: "https://cyberchef.org/",
    description: "用于编码、解码、格式转换和文本处理的网页工具，适合学习数据处理的基本思路。",
    note: "不要把密码、验证码、个人证件或未公开的敏感数据粘贴进去。",
  },
  {
    id: "desmos",
    name: "Desmos 图形计算器",
    url: "https://www.desmos.com/calculator",
    description: "在线图形计算器，适合把函数、参数变化和坐标关系直接画出来观察。",
  },
];

export const digitalStarterSafetyNotes = [
  "优先从官网或可信应用商店下载软件",
  "普通 Windows 用户不需要同时安装各种安全卫士、软件管家或系统清理器",
  "Windows 自带的 Defender、防火墙和系统更新先保持正常运行",
  "不要随便运行陌生 exe 文件",
  "不要把验证码、密码和身份证号发给别人或 AI",
  "重要文件至少保留一份备份",
  "遇到报错时，先保存截图和错误信息",
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
