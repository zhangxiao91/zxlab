import type { LabProject } from "./types";

export const labProjects: LabProject[] = [
  {
    slug: "trading",
    title: "交易工作台",
    description:
      "把持仓账本、行情事实、交易记录与账户/盘后复盘收进同一个只读工作域；各数据源仍保持独立边界。",
    status: "beta",
    category: "Trading Workspace",
    cardLabels: ["持仓", "行情", "复盘"],
    tags: ["Ledger", "Market", "Evidence"],
    featured: true,
    thumbnail: "https://picsum.photos/seed/trading-workspace-ledger/1600/1200",
    thumbnailAlt: "深色交易工作台抽象图，用于表示持仓、行情与复盘的统一入口",
    href: "/lab/trading",
    customPage: true,
    deviceSupport: ["desktop", "touch", "keyboard", "pointer"],
  },
  {
    slug: "yuzi",
    title: "余字",
    description:
      "五回合生成式文字构筑游戏。从世界回应中剪下完整意群，以全文缺口为代价，把那封未寄出的信带到天亮以前。",
    status: "beta",
    category: "Narrative Game",
    cardLabels: ["Generative Game", "Five Turns"],
    tags: ["Narrative", "LLM", "Word Building"],
    featured: true,
    thumbnail: "/assets/lab/yuzi-preview.webp",
    thumbnailAlt: "黎明前的山谷与云层，用于表示余字的未寄出手稿",
    href: "/lab/yuzi",
    customPage: true,
    supportsFullscreen: true,
    minHeight: "46rem",
    deviceSupport: ["desktop", "touch", "keyboard", "pointer"],
    links: [
      {
        label: "GitHub repository",
        href: "https://github.com/zhangxiao91/yuzi",
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
