import type { LabProject } from "./types";

export const labProjects: LabProject[] = [
  {
    slug: "market",
    title: "Market Center",
    description:
      "行情、K 线、公告、7x24 新闻与 provider health 的统一入口。Risk 只消费这里的结果，不再各自拼接行情请求。",
    status: "beta",
    category: "Market Console",
    cardLabels: ["Quotes", "News", "Health"],
    tags: ["Quotes", "K-Line", "Announcements"],
    featured: true,
    thumbnail: "https://picsum.photos/seed/market-console-ledger/1600/1200",
    thumbnailAlt: "深色行情控制台抽象图，用于表示 Market Center",
    href: "/lab/market",
    customPage: true,
    deviceSupport: ["desktop", "touch", "keyboard", "pointer"],
  },
  {
    slug: "risk",
    title: "持仓风险台",
    description:
      "只读的个人持仓风险监控与操作复盘工作台。确定性计算负责数字，Evidence Pack 负责让每条解释可追溯。",
    status: "wip",
    category: "Private Finance Tool",
    cardLabels: ["Risk Monitor", "Read Only"],
    tags: ["Portfolio", "Evidence", "Review"],
    featured: true,
    thumbnail: "https://picsum.photos/seed/risk-signal-ledger/1600/1200",
    thumbnailAlt: "抽象的深色数据光轨，用于表示持仓风险与证据链",
    href: "/lab/risk",
    customPage: true,
    deviceSupport: ["desktop", "touch", "keyboard", "pointer"],
  },
  {
    slug: "yuzhi",
    title: "余字",
    description:
      "五回合生成式文字构筑游戏。从世界回应中剪下完整意群，以全文缺口为代价，把那封未寄出的信带到天亮以前。",
    status: "beta",
    category: "Narrative Game",
    cardLabels: ["Generative Game", "Five Turns"],
    tags: ["Narrative", "LLM", "Word Building"],
    featured: true,
    thumbnail: "/assets/lab/yuzhi-preview.webp",
    thumbnailAlt: "黎明前的山谷与云层，用于表示余字的未寄出手稿",
    href: "/lab/yuzhi",
    customPage: true,
    supportsFullscreen: true,
    minHeight: "46rem",
    deviceSupport: ["desktop", "touch", "keyboard", "pointer"],
    links: [
      {
        label: "GitHub repository",
        href: "https://github.com/zhangxiao91/yuzhi",
        external: true,
      },
    ],
  },
  {
    slug: "stonks",
    title: "STONKS",
    description:
      "虚构市场策略游戏。包含封板、炸板、流动性与情绪博弈等元素。仅供娱乐，不构成任何投资建议，不代表任何国家的真实市场。",
    status: "wip",
    category: "Game Prototype",
    cardLabels: ["Game Prototype", "Desktop Only"],
    tags: ["Simulation", "Strategy", "Desktop Only"],
    featured: false,
    thumbnail: "/assets/lab/stonks-preview.svg",
    thumbnailAlt: "STONKS 虚构市场模拟界面预览",
    href: "/lab/stonks/",
    customPage: true,
    deviceSupport: ["desktop", "keyboard", "pointer"],
    links: [
      {
        label: "原始 GitHub 仓库",
        href: "https://github.com/zhangxiao91/STONKS-WIP-zx",
        external: true,
      },
    ],
  },
  {
    slug: "strudel",
    title: "Strudel Playground",
    description:
      "A browser-based live coding desk for shaping a 138 BPM trance pattern with Strudel.",
    status: "beta",
    category: "Live Coding",
    tags: ["Audio", "Strudel", "WebAudio"],
    featured: true,
    thumbnail: "https://picsum.photos/seed/trance-signal-room/1600/1200",
    thumbnailAlt: "Abstract green light trails selected to represent live-coded electronic music",
    supportsFullscreen: true,
    minHeight: "46rem",
    deviceSupport: ["desktop", "touch", "keyboard", "pointer"],
    customPage: true,
    instructions: [
      "Click inside the Strudel editor before running the pattern so the browser can unlock audio.",
      "Use Control or Command plus Enter to run, and Control or Command plus period to stop.",
      "Leaving this page or resetting the template destroys the embedded player and stops its audio context.",
    ],
    links: [
      { label: "Strudel documentation", href: "https://strudel.cc/learn/", external: true },
    ],
  },
  {
    slug: "digital-starter",
    title: "准大学生数字技能启动包",
    description:
      "电脑、AI 和一点点编程的暑假数字技能资料入口，用来承接一次轻量数字技能培训。",
    status: "beta",
    category: "Digital Literacy",
    tags: ["AI", "Markdown", "GitHub"],
    featured: false,
    thumbnail: "https://picsum.photos/seed/digital-starter-toolkit/1600/1200",
    thumbnailAlt: "Abstract desktop workspace selected for a digital skills starter kit",
    customPage: true,
    deviceSupport: ["desktop", "touch", "keyboard", "pointer"],
    instructions: [
      "This custom Lab page is a resource index and does not load a separate client experiment.",
      "Future documents, files, and external links will be connected through the page data source.",
    ],
  },
];

export function getLabProject(slug: string) {
  return labProjects.find((project) => project.slug === slug);
}

export function getLabProjectHref(project: LabProject) {
  return project.href ?? `/lab/${project.slug}`;
}
