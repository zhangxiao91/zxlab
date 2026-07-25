import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = new URL("../", import.meta.url);
const functionsRoot = new URL("../functions/", import.meta.url);
const routesFile = new URL("../public/_routes.json", import.meta.url);

async function listFunctionFiles(directory, relative = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith("_")) continue;
    const nextRelative = path.posix.join(relative, entry.name);
    const nextUrl = new URL(`${nextRelative}${entry.isDirectory() ? "/" : ""}`, functionsRoot);

    if (entry.isDirectory()) {
      files.push(...await listFunctionFiles(nextUrl, nextRelative));
    } else if (/\.[cm]?[jt]s$/.test(entry.name)) {
      files.push(nextRelative);
    }
  }

  return files;
}

function functionRoute(file) {
  const segments = file.replace(/\.[cm]?[jt]s$/, "").split("/");
  if (segments.at(-1) === "index") segments.pop();
  return `/${segments.map((segment) => segment.replace(/^\[\[?.+\]?\]$/, "*")).join("/")}`;
}

function routePatternMatches(pattern, route) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(route);
}

const config = JSON.parse(await readFile(routesFile, "utf8"));
const includes = Array.isArray(config.include) ? config.include : [];
const routes = (await listFunctionFiles(functionsRoot)).map(functionRoute).sort();
const missing = routes.filter((route) => !includes.some((pattern) => routePatternMatches(pattern, route)));

if (missing.length > 0) {
  console.error(`Pages Functions missing from public/_routes.json:\n${missing.map((route) => `- ${route}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(`Verified ${routes.length} Pages Function routes against ${path.relative(projectRoot.pathname, routesFile.pathname)}.`);
}
