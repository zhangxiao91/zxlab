import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";

const outputDir = join(process.cwd(), "dist");
const functionsDir = join(process.cwd(), "functions");

if (!existsSync(outputDir)) {
  console.error("站内链接检查失败：没有找到 dist，请先运行构建。");
  process.exit(1);
}

const walkHtml = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walkHtml(path);
    return entry.name.endsWith(".html") ? [path] : [];
  });

const htmlFiles = walkHtml(outputDir);
const walkFunctions = (directory, segments = []) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith("_")) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walkFunctions(path, [...segments, entry.name]);
    if (!/\.[cm]?[jt]s$/.test(entry.name)) return [];
    const routeSegments = [...segments, entry.name.replace(/\.[cm]?[jt]s$/, "")];
    if (routeSegments.at(-1) === "index") routeSegments.pop();
    const pattern = routeSegments.map((segment) => {
      if (/^\[\[.+\]\]$/.test(segment)) return ".*";
      if (/^\[.+\]$/.test(segment)) return "[^/]+";
      return segment.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }).join("/");
    return [new RegExp(`^/${pattern}/?$`)];
  });
const functionRoutes = existsSync(functionsDir) ? walkFunctions(functionsDir) : [];
const failures = [];
let checkedLinks = 0;

const routeExists = (pathname) => {
  const decodedPath = decodeURIComponent(pathname);
  const relativePath = decodedPath.replace(/^\/+/, "");
  const exactPath = join(outputDir, relativePath);

  if (existsSync(exactPath) && extname(exactPath)) return true;
  if (existsSync(join(exactPath, "index.html"))) return true;
  if (existsSync(`${exactPath}.html`)) return true;
  if (functionRoutes.some((pattern) => pattern.test(decodedPath))) return true;
  return false;
};

for (const htmlFile of htmlFiles) {
  const html = readFileSync(htmlFile, "utf8");
  const routePath = `/${relative(outputDir, htmlFile).replace(/index\.html$/, "").replace(/\\/g, "/")}`;
  const linkPattern = /href=["']([^"']+)["']/g;

  for (const match of html.matchAll(linkPattern)) {
    const href = match[1].trim();
    if (!href || href.startsWith("#") || /^(https?:|mailto:|tel:|javascript:)/.test(href)) continue;

    const url = new URL(href, `https://zxlab.local${routePath}`);
    checkedLinks += 1;

    if (!routeExists(url.pathname)) {
      failures.push({ source: routePath || "/", href });
    }
  }
}

if (failures.length > 0) {
  console.error(`站内链接检查失败：发现 ${failures.length} 个失效入口。`);
  failures.forEach(({ source, href }) => console.error(`- ${source} -> ${href}`));
  process.exit(1);
}

console.log(`站内链接检查通过：检查 ${htmlFiles.length} 个页面、${checkedLinks} 个站内链接。`);
