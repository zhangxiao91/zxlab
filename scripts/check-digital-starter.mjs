import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

const root = new URL("../", import.meta.url);
const data = await import(new URL("src/data/digitalStarter.ts", root));

const allowedStatuses = new Set(["open"]);
const failures = [];
const collections = [
  ["routes", data.digitalStarterRoutes],
  ["modules", data.digitalStarterRouteModules],
  ["docs", data.digitalStarterDocs],
  ["assets", data.digitalStarterAssets],
  ["resources", data.digitalStarterResources],
  ["featured", data.digitalStarterFeaturedResources],
  ["tasks", data.digitalStarterTasks],
  ["software", data.digitalStarterSoftwareTools],
  ["websites", data.digitalStarterWebsiteRecommendations],
];

for (const [name, items] of collections) {
  const ids = new Set();
  for (const item of items) {
    if (ids.has(item.id)) failures.push(`${name}: duplicate id ${item.id}`);
    ids.add(item.id);
    if (!allowedStatuses.has(item.status)) failures.push(`${name}/${item.id}: invalid status ${item.status}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(item.updatedAt)) failures.push(`${name}/${item.id}: invalid updatedAt`);
  }
}

for (const route of data.digitalStarterRoutes) {
  if (!route.detailHref) failures.push(`route/${route.id}: missing detailHref`);
  if (route.status !== "open") failures.push(`route/${route.id}: course route must be open`);
}

const docIds = new Set(data.digitalStarterDocs.map((doc) => doc.id));
const taskIds = new Set(data.digitalStarterTasks.map((task) => task.id));
for (const module of data.digitalStarterRouteModules) {
  if (!module.coreDocumentId) {
    failures.push(`module/${module.id}: missing core document`);
  } else if (!docIds.has(module.coreDocumentId)) {
    failures.push(`module/${module.id}: missing core document ${module.coreDocumentId}`);
  }
  if (module.extensionDocumentId && !docIds.has(module.extensionDocumentId)) {
    failures.push(`module/${module.id}: missing extension document ${module.extensionDocumentId}`);
  }
  if (module.practiceTaskId && !taskIds.has(module.practiceTaskId)) {
    failures.push(`module/${module.id}: missing practice task ${module.practiceTaskId}`);
  }
}

const contentDir = new URL("src/content/digital-starter/", root);
const requiredDocs = [
  "computer-basics.md",
  "file-management.md",
  "browser-basics.md",
  "safe-download.md",
  "device-sync.md",
  "hardware-basics.md",
  "office-tools.md",
  "troubleshooting.md",
  "anti-fraud.md",
  "tasks.md",
  "safe-install-task.md",
  "ai-intro.md",
  "ai-practical.md",
  "hello-world.md",
  "command-line.md",
  "markdown-start.md",
  "github-basics.md",
  "digital-boundaries.md",
  "ai-coding.md",
  "file-structure.md",
  "help-prompt.md",
  "keyboard-shortcuts.md",
];
for (const file of requiredDocs) {
  if (!existsSync(new URL(file, contentDir))) failures.push(`missing content file ${file}`);
}

const contentFiles = (await readdir(contentDir)).filter((file) => file.endsWith(".md"));
for (const file of contentFiles) {
  const source = await readFile(new URL(file, contentDir), "utf8");
  const status = source.match(/^status:\s*["']([^"']+)["']/m)?.[1];
  const updatedAt = source.match(/^updatedAt:\s*(\d{4}-\d{2}-\d{2})/m)?.[1];
  if (!allowedStatuses.has(status)) failures.push(`${file}: invalid frontmatter status`);
  if (!updatedAt) failures.push(`${file}: missing frontmatter updatedAt`);
  if (!/^status:\s*["']?open["']?\s*$/m.test(source)) failures.push(`${file}: completed content must be open`);
  if (!/^updatedAt:\s*2026-07-28\s*$/m.test(source)) failures.push(`${file}: completion date must be 2026-07-28`);
  for (const marker of ["本节内容待补充", "仍在制作中", "正文内容待补充", "即将开放"]) {
    if (source.includes(marker)) failures.push(`${file}: unfinished marker remains: ${marker}`);
  }
}

const expectedModuleOrder = {
  computer: [
    "file-management",
    "hardware-basics",
    "keyboard-input",
    "software-safety",
    "device-sync",
    "browser-basics",
    "office-tools",
    "troubleshooting",
    "anti-fraud",
    "not-easy-to-say",
  ],
  ai: ["ai-intro", "ai-ppt"],
  coding: ["hello-world", "command-line", "markdown", "github", "vibe-coding"],
};
for (const [routeId, expectedIds] of Object.entries(expectedModuleOrder)) {
  const actualIds = data.digitalStarterRouteModules.filter((item) => item.routeId === routeId).map((item) => item.id);
  if (actualIds.join(",") !== expectedIds.join(",")) {
    failures.push(`route/${routeId}: module order is ${actualIds.join(",")}`);
  }
}

const docsById = new Map(data.digitalStarterDocs.map((doc) => [doc.id, doc]));
const tasksById = new Map(data.digitalStarterTasks.map((task) => [task.id, task]));
for (const module of data.digitalStarterRouteModules) {
  const coreDoc = module.coreDocumentId ? docsById.get(module.coreDocumentId) : undefined;
  if (coreDoc && coreDoc.status !== module.status) {
    failures.push(`module/${module.id}: module status ${module.status} differs from document status ${coreDoc.status}`);
  }
  const practiceTask = module.practiceTaskId ? tasksById.get(module.practiceTaskId) : undefined;
  if (module.status === "open" && practiceTask && practiceTask.status !== "open") {
    failures.push(`module/${module.id}: open module references non-open task ${practiceTask.id}`);
  }
}

for (const [name, items] of collections) {
  for (const item of items) {
    if (item.status !== "open") failures.push(`${name}/${item.id}: every published item must be open`);
  }
}

const computerBasics = await readFile(new URL("computer-basics.md", contentDir), "utf8");
if (/^##\s+\d+\./m.test(computerBasics)) failures.push("computer-basics.md: detailed numbered sections remain");
if (computerBasics.includes("建议先整理一个大学资料文件夹") || computerBasics.includes("推荐软件与插件")) {
  failures.push("computer-basics.md: legacy large-page copy remains");
}

const source = await readFile(new URL("src/data/digitalStarter.ts", root), "utf8");
const routeDetailSource = await readFile(new URL("src/components/digital-starter/RouteDetailPage.astro", root), "utf8");
const homeSource = await readFile(new URL("src/pages/lab/digital-starter.astro", root), "utf8");
const docPageSource = await readFile(new URL("src/pages/lab/digital-starter/docs/[id].astro", root), "utf8");
const toolboxSource = await readFile(new URL("src/pages/lab/digital-starter/docs/software-toolbox.astro", root), "utf8");
const teachingSource = await readFile(new URL("src/pages/lab/digital-starter/teaching.astro", root), "utf8");
if (source.includes("publicStatus") || source.includes("DigitalStarterPublicStatus")) failures.push("data: publicStatus model remains");
for (const legacy of ["status: \"planned\"", "status: \"draft\"", "status: \"ready\"", "status: \"writing\"", "status: \"todo\"", "status: \"pending\"", "status: \"organizing\"", "status: \"placeholder\"", "status: \"building\""]) {
  if (source.includes(legacy)) failures.push(`data: legacy status remains: ${legacy}`);
}
if (source.includes("推荐软件与插件")) failures.push("data: legacy toolbox title remains");
for (const marker of ["内容待补充", "正文待补充", "即将开放", "后续逐步开放", "基础版内容"]) {
  if (routeDetailSource.includes(marker) || homeSource.includes(marker)) failures.push(`page: unfinished marker remains: ${marker}`);
}
const publicPageSources = [routeDetailSource, homeSource, docPageSource, toolboxSource];
for (const marker of ["状态：", "已开放", "完整课程已开放", "保留入口", "查看路线入口", "内容演进", "统一的数据结构"]) {
  if (publicPageSources.some((pageSource) => pageSource.includes(marker))) {
    failures.push(`page: development-facing copy remains: ${marker}`);
  }
}
for (const implementationMarker of ["digitalStarterUpdates", "digitalStarterStatusLabels", "data-public-status", "entryHref ?"]) {
  if (publicPageSources.some((pageSource) => pageSource.includes(implementationMarker))) {
    failures.push(`page: obsolete fallback remains: ${implementationMarker}`);
  }
}
for (const obsoleteExport of ["DigitalStarterUpdate", "digitalStarterRoadmap", "digitalStarterUpdates", "digitalStarterConnectionNotes", "digitalStarterStatusLabels"]) {
  if (source.includes(obsoleteExport)) failures.push(`data: obsolete development export remains: ${obsoleteExport}`);
}
if (!routeDetailSource.includes('"software-shortlist": "/lab/digital-starter/docs/safe-install-task"')) {
  failures.push("route detail: software install task does not use its dedicated document");
}
if (!teachingSource.includes("3 次课 · 270 分钟") || !teachingSource.includes("data-teaching-print")) {
  failures.push("teaching page: course plan or print mode is incomplete");
}

for (const category of data.digitalStarterSoftwareCategories) {
  if (!data.digitalStarterSoftwareTools.some((tool) => tool.category === category)) {
    failures.push(`software category has no recommendation: ${category}`);
  }
}
for (const resource of data.digitalStarterFeaturedResources) {
  if (!resource.href) failures.push(`featured/${resource.id}: missing usable href`);
}

const requiredAssets = [
  "public/assets/digital-starter/computer/college-folder-template.zip",
  "public/assets/digital-starter/examples/hello.html",
  "public/assets/digital-starter/examples/README.md",
  "public/assets/digital-starter/examples/ai-coding-request.txt",
  "public/assets/digital-starter/ai-ppt/example-source.md",
  "public/assets/digital-starter/ai-ppt/verified-outline.md",
  "public/assets/digital-starter/slides/facilitator-outline.md",
];
for (const file of requiredAssets) {
  const url = new URL(file, root);
  if (!existsSync(url)) {
    failures.push(`missing course asset ${file}`);
  } else if ((await stat(url)).size < 80) {
    failures.push(`course asset is empty or placeholder-sized: ${file}`);
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Digital Starter 校验通过：${collections.reduce((sum, [, items]) => sum + items.length, 0)} 个数据条目、${requiredDocs.length} 个核心文档。`);
