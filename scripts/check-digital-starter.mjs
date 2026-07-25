import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const root = new URL("../", import.meta.url);
const data = await import(new URL("src/data/digitalStarter.ts", root));

const allowedStatuses = new Set(["open", "placeholder", "building"]);
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
}

const docIds = new Set(data.digitalStarterDocs.map((doc) => doc.id));
const taskIds = new Set(data.digitalStarterTasks.map((task) => task.id));
for (const module of data.digitalStarterRouteModules) {
  if (module.coreDocumentId && !docIds.has(module.coreDocumentId)) {
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
  if (status === "placeholder") failures.push(`${file}: placeholder content must include a usable basic version`);
}

const openContentFiles = [
  "file-management.md",
  "browser-basics.md",
  "safe-download.md",
  "device-sync.md",
  "troubleshooting.md",
  "anti-fraud.md",
  "office-tools.md",
  "tasks.md",
  "safe-install-task.md",
  "ai-intro.md",
  "ai-practical.md",
  "hello-world.md",
  "command-line.md",
  "markdown-start.md",
  "github-basics.md",
];
for (const file of openContentFiles) {
  const source = await readFile(new URL(file, contentDir), "utf8");
  if (!/^status:\s*["']?open["']?\s*$/m.test(source)) failures.push(`${file}: completed content must be open`);
  if (!/^updatedAt:\s*2026-07-25\s*$/m.test(source)) failures.push(`${file}: construction date was not updated`);
}

const foundationContentFiles = ["hardware-basics.md", "digital-boundaries.md", "ai-coding.md"];
for (const file of foundationContentFiles) {
  const source = await readFile(new URL(file, contentDir), "utf8");
  if (!/^status:\s*["']?building["']?\s*$/m.test(source)) failures.push(`${file}: basic version must remain visibly marked as building`);
  if (!/^updatedAt:\s*2026-07-26\s*$/m.test(source)) failures.push(`${file}: basic version date was not updated`);
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

const aiRoute = data.digitalStarterRoutes.find((route) => route.id === "ai");
const codingRoute = data.digitalStarterRoutes.find((route) => route.id === "coding");
if (aiRoute?.status !== "building") failures.push("route/ai: first real slice should mark route as building");
if (codingRoute?.status !== "building") failures.push("route/coding: minimum learning loop should mark route as building");
if (data.digitalStarterRouteModules.find((module) => module.id === "vibe-coding")?.status !== "building") {
  failures.push("module/vibe-coding: AI Coding basic version must remain visibly marked as building");
}
for (const [name, items] of collections) {
  for (const item of items) {
    if (item.status === "placeholder") failures.push(`${name}/${item.id}: placeholder item must include a usable basic version`);
  }
}

const computerBasics = await readFile(new URL("computer-basics.md", contentDir), "utf8");
if (/^##\s+\d+\./m.test(computerBasics)) failures.push("computer-basics.md: detailed numbered sections remain");
if (computerBasics.includes("建议先整理一个大学资料文件夹") || computerBasics.includes("推荐软件与插件")) {
  failures.push("computer-basics.md: legacy large-page copy remains");
}

const source = await readFile(new URL("src/data/digitalStarter.ts", root), "utf8");
const routeDetailSource = await readFile(new URL("src/components/digital-starter/RouteDetailPage.astro", root), "utf8");
if (source.includes("publicStatus") || source.includes("DigitalStarterPublicStatus")) failures.push("data: publicStatus model remains");
for (const legacy of ["status: \"planned\"", "status: \"draft\"", "status: \"ready\"", "status: \"writing\"", "status: \"todo\"", "status: \"pending\"", "status: \"organizing\""]) {
  if (source.includes(legacy)) failures.push(`data: legacy status remains: ${legacy}`);
}
if (source.includes("推荐软件与插件")) failures.push("data: legacy toolbox title remains");
if (!routeDetailSource.includes('"software-shortlist": "/lab/digital-starter/docs/safe-install-task"')) {
  failures.push("route detail: software install task does not use its dedicated document");
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Digital Starter 校验通过：${collections.reduce((sum, [, items]) => sum + items.length, 0)} 个数据条目、${requiredDocs.length} 个核心文档。`);
