#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const PROXY_BINARY = fileURLToPath(new URL("./.bin/zxlab-access-proxy", import.meta.url));
const SIMPLE_OPERATIONS = new Set([
  "status",
  "migrate",
  "provision",
  "profile",
  "today",
  "quality",
  "watchlist-status",
]);

export function parseProxyArguments(argv) {
  if (argv.length === 0) return ["profile"];
  const [operation, ...rest] = argv;
  if (operation === "--help" || operation === "-h") return ["help"];
  if (SIMPLE_OPERATIONS.has(operation)) {
    if (rest.length !== 0) throw new Error(`${operation} does not accept arguments.`);
    return [operation];
  }
  if (operation === "run-create") {
    if (rest.length !== 2 || rest[0] !== "--instrument" || !rest[1] || rest[1].startsWith("--")) {
      throw new Error("run-create requires --instrument <canonical-id>.");
    }
    return [operation, ...rest];
  }
  if (operation === "run-status") {
    if (rest.length !== 2 || rest[0] !== "--run-id" || !rest[1] || rest[1].startsWith("--")) {
      throw new Error("run-status requires --run-id <id>.");
    }
    return [operation, ...rest];
  }
  throw new Error("Unknown operation. Arbitrary methods, paths, bodies, and URLs are not supported.");
}

export function runAccessProxy(argv, runner = spawnSync, binaryExists = existsSync) {
  const arguments_ = parseProxyArguments(argv);
  if (arguments_[0] === "help") return { help: true };
  if (!binaryExists(PROXY_BINARY)) {
    throw new Error("ZXLab Access proxy is not installed. Run npm run access:debug:install first.");
  }
  const result = runner(PROXY_BINARY, arguments_, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.error) throw new Error("ZXLab Access proxy could not be started.");
  if (result.status !== 0) {
    const message = result.stderr?.trim();
    throw new Error(message || "ZXLab Access proxy request failed.");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("ZXLab Access proxy returned invalid output.");
  }
}

function printHelp() {
  console.log(`ZXLab dedicated native Access proxy

Usage:
  npm run access:debug
  npm run access:debug -- status
  npm run access:debug -- today
  npm run access:debug -- quality
  npm run access:debug -- watchlist-status
  npm run access:debug -- run-create --instrument SSE:600000
  npm run access:debug -- run-status --run-id <id>

One-time setup in an interactive terminal:
  npm run access:debug:setup

The signed native proxy owns Keychain access and the pinned HTTPS request. It
never returns credentials or raw private response bodies to Node or Codex.`);
}

async function main() {
  const result = runAccessProxy(process.argv.slice(2));
  if (result.help) return printHelp();
  console.log(JSON.stringify(result, null, 2));
  if (result.ok === false) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "ZXLab Access proxy failed.");
    process.exitCode = 1;
  });
}
