import type { LabProject } from "./types";

export const labProjects: LabProject[] = [
  {
    slug: "interaction-sandbox",
    title: "Interaction Sandbox",
    description:
      "A planned workspace for small input, timing, and interface-motion studies.",
    status: "coming-soon",
    category: "Web Interaction",
    tags: ["Input", "Motion", "Interface"],
    featured: true,
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
