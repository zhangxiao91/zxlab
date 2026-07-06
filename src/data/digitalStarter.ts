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
  ready: "已完成",
  writing: "编写中",
  todo: "待补充",
  pending: "待接入",
  organizing: "整理中",
};

export const digitalStarterRoutes: DigitalStarterRoute[] = [
  {
    id: "computer",
    title: "只想会用电脑",
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
    ],
    resourceIds: [
      "computer-basics",
      "keyboard-shortcuts-doc",
      "safe-download-guide",
      "college-folder-template",
      "screenshot-unzip-task",
      "sync-plan-doc",
      "computer-help-prompt",
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
  },
  {
    id: "keyboard-shortcuts",
    routeId: "computer",
    title: "键盘与快捷键",
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
  },
];

export const digitalStarterDocs: DigitalStarterDoc[] = [
  {
    id: "computer-basics",
    title: "电脑基础速查表",
    routeId: "computer",
    description: "面向准大学生的 Windows 电脑基础操作小抄。",
    path: "/lab/digital-starter/docs/computer-basics",
    status: "ready",
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
    id: "file-structure-doc",
    title: "大学资料文件夹模板",
    routeId: "computer",
    description: "给课程、作业、证件、项目、临时下载和归档备份预留一套清晰结构。",
    path: "/lab/digital-starter/docs/file-structure",
    status: "pending",
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
    id: "computer-help-prompt-doc",
    title: "电脑问题求助模板",
    routeId: "computer",
    description: "把报错、截图、设备信息和已经尝试过的方法整理清楚，再去求助。",
    path: "/lab/digital-starter/docs/help-prompt",
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
    status: "ready",
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
    status: "todo",
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
    status: "writing",
    tags: ["文档", "软件工具"],
    actionLabel: "查看指南",
  },
  {
    id: "college-folder-template",
    title: "大学资料文件夹模板",
    type: "file",
    routeId: "computer",
    description: "提供一套适合大学新生的文件夹结构示例，用于整理课程、作业、证件、项目和临时下载。",
    url: "/assets/digital-starter/computer/",
    status: "pending",
    tags: ["示例文件", "文件管理"],
    actionLabel: "查看模板",
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
    actionLabel: "查看任务",
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
    actionLabel: "查看方案",
  },
  {
    id: "computer-help-prompt",
    title: "电脑问题求助模板",
    type: "prompt",
    routeId: "computer",
    description: "教新手把“电脑出问题了”描述清楚，方便向同学、搜索引擎或 AI 求助。",
    url: "/lab/digital-starter/docs/help-prompt",
    status: "todo",
    tags: ["Prompt", "求助"],
    actionLabel: "复制模板",
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
    status: "todo",
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

export const digitalStarterSafetyNotes = [
  "优先从官网或可信应用商店下载软件",
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
