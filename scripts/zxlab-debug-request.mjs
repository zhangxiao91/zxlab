#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEBUG_ORIGIN = "https://debug-beta.zxlab.pages.dev";
const KEYCHAIN_ACCOUNT = "codex";
const KEYCHAIN_CLIENT_ID = "zxlab.debug-access.client-id";
const KEYCHAIN_CLIENT_SECRET = "zxlab.debug-access.client-secret";
const PRIVATE_MARKET_AGENT_PREFIX = "/api/private/market-agent/";

export function parseRequestArguments(argv) {
  const request = { method: "GET", path: "/api/private/market-agent/profile", body: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--method") request.method = requiredValue(argv, ++index, argument).toUpperCase();
    else if (argument === "--path") request.path = requiredValue(argv, ++index, argument);
    else if (argument === "--body") request.body = requiredValue(argv, ++index, argument);
    else if (argument === "--help" || argument === "-h") return { help: true };
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    throw new Error(`Unsupported HTTP method: ${request.method}`);
  }
  if (!request.path.startsWith(PRIVATE_MARKET_AGENT_PREFIX) || request.path.includes("\\") || request.path.includes("\0")) {
    throw new Error(`Path must stay under ${PRIVATE_MARKET_AGENT_PREFIX}`);
  }
  const url = new URL(request.path, DEBUG_ORIGIN);
  if (url.origin !== DEBUG_ORIGIN || !url.pathname.startsWith(PRIVATE_MARKET_AGENT_PREFIX)) {
    throw new Error("Request URL escaped the dedicated ZXLab debug origin.");
  }
  if ((request.method === "GET" || request.method === "HEAD") && request.body !== undefined) {
    throw new Error(`${request.method} requests cannot include --body.`);
  }
  if (request.body !== undefined) JSON.parse(request.body);
  return { help: false, ...request, url };
}

export function readDebugAccessCredentials(readPassword = readKeychainPassword) {
  const clientId = readPassword(KEYCHAIN_CLIENT_ID).trim();
  const clientSecret = readPassword(KEYCHAIN_CLIENT_SECRET).trim();
  if (!clientId || !clientSecret) throw new Error("ZXLab debug Access credentials are incomplete in Keychain.");
  return { clientId, clientSecret };
}

export async function performDebugRequest(request, credentials, fetcher = fetch) {
  const response = await fetcher(request.url, {
    method: request.method,
    headers: {
      accept: "application/json",
      ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      "CF-Access-Client-Id": credentials.clientId,
      "CF-Access-Client-Secret": credentials.clientSecret,
    },
    ...(request.body === undefined ? {} : { body: request.body }),
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  return {
    status: response.status,
    location: response.headers.get("location"),
    body: request.method === "HEAD" ? "" : await response.text(),
  };
}

function readKeychainPassword(service) {
  try {
    return execFileSync("/usr/bin/security", ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", service, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error(`Missing Keychain item: ${service} (account ${KEYCHAIN_ACCOUNT}).`);
  }
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function printHelp() {
  console.log(`ZXLab dedicated Agent debug request

Usage:
  npm run access:debug
  npm run access:debug -- --path /api/private/market-agent/today
  npm run access:debug -- --method POST --path /api/private/market-agent/ask --body '{"scope":"today_change"}'

Credentials are read directly from macOS Keychain and are never printed. The
origin is fixed to ${DEBUG_ORIGIN}; redirects are not followed.`);
}

async function main() {
  const request = parseRequestArguments(process.argv.slice(2));
  if (request.help) return printHelp();
  const result = await performDebugRequest(request, readDebugAccessCredentials());
  console.log(`HTTP ${result.status}`);
  if (result.location) console.log(`Location: ${new URL(result.location, DEBUG_ORIGIN).origin}`);
  if (result.body) console.log(result.body);
  if (result.status < 200 || result.status >= 300) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "ZXLab debug request failed.");
    process.exitCode = 1;
  });
}

