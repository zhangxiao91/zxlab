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
  "hardware-basics.md",
  "office-tools.md",
  "troubleshooting.md",
  "anti-fraud.md",
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
}

const computerBasics = await readFile(new URL("computer-basics.md", contentDir), "utf8");
if (/^##\s+\d+\./m.test(computerBasics)) failures.push("computer-basics.md: detailed numbered sections remain");
if (computerBasics.includes("建议先整理一个大学资料文件夹") || computerBasics.includes("推荐软件与插件")) {
  failures.push("computer-basics.md: legacy large-page copy remains");
}

const source = await readFile(new URL("src/data/digitalStarter.ts", root), "utf8");
if (source.includes("publicStatus") || source.includes("DigitalStarterPublicStatus")) failures.push("data: publicStatus model remains");
for (const legacy of ["status: \"planned\"", "status: \"draft\"", "status: \"ready\"", "status: \"writing\"", "status: \"todo\"", "status: \"pending\"", "status: \"organizing\""]) {
  if (source.includes(legacy)) failures.push(`data: legacy status remains: ${legacy}`);
}
if (source.includes("推荐软件与插件")) failures.push("data: legacy toolbox title remains");

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log(`Digital Starter 校验通过：${collections.reduce((sum, [, items]) => sum + items.length, 0)} 个数据条目、${requiredDocs.length} 个核心文档。`);
