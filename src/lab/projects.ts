import type { LabProject } from "./types";

export const labProjects: LabProject[] = [
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
  {
    slug: "interaction-sandbox",
    title: "Interaction Sandbox",
    description:
      "A planned workspace for small input, timing, and interface-motion studies.",
    status: "coming-soon",
    category: "Web Interaction",
    tags: ["Input", "Motion", "Interface"],
    featured: false,
    thumbnail: "https://picsum.photos/seed/interaction-signal/1600/1200",
    thumbnailAlt: "Abstract rings and light selected for the planned interaction sandbox",
    supportsFullscreen: true,
    minHeight: "34rem",
    deviceSupport: ["desktop", "touch", "keyboard", "pointer"],
    instructions: [
      "The experiment will explain its controls here when it becomes available.",
      "Keyboard and touch alternatives will be documented alongside pointer input.",
    ],
  },
  {
    slug: "evaluation-workbench",
    title: "Evaluation Workbench",
    description:
      "A planned surface for compact AI evaluation tools and visual comparisons.",
    status: "coming-soon",
    category: "AI Experiment",
    tags: ["Evaluation", "AI", "Tooling"],
    thumbnail: "https://picsum.photos/seed/evaluation-instrument/1400/1200",
    thumbnailAlt: "Abstract instrument-like structure selected for a planned evaluation tool",
    supportsFullscreen: true,
    minHeight: "34rem",
    deviceSupport: ["desktop", "keyboard", "pointer"],
    instructions: [
      "The workbench will publish its supported inputs before the first beta release.",
      "No model requests or private data are connected in this placeholder version.",
    ],
  },
];

export function getLabProject(slug: string) {
  return labProjects.find((project) => project.slug === slug);
}

export function getLabProjectHref(project: LabProject) {
  return project.href ?? `/lab/${project.slug}`;
}
