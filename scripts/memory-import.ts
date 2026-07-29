import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { planMemoryImport, parseMemoryManifest, type ImportPlanEntry, type RemoteMemory } from "./memory-import-core.ts";

const execFileAsync = promisify(execFile);
const betaBaseUrl = "https://beta.zxlab.pages.dev/api/private/runtime/api/v1/private/memory";

interface MemoryResponse {
  memories: RemoteMemory[];
}

interface CliOptions {
  file: string;
  apply: boolean;
  baseUrl: string;
  cloudflared: string;
  json: boolean;
}

function usage(): string {
  return `Usage:
  npm run memory:import -- <manifest.yaml> [--env beta] [--dry-run]
  npm run memory:import -- <manifest.yaml> --env beta --apply

Options:
  --env beta              Use the protected beta Runtime proxy (default)
  --base-url <url>        Override the Memory API base URL
  --cloudflared <path>    Override the cloudflared executable
  --apply                 Execute creates and updates
  --dry-run               Print the plan without writing (default)
  --json                  Print machine-readable output
  --help                  Show this help`;
}

function options(): CliOptions {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      env: { type: "string", default: "beta" },
      "base-url": { type: "string" },
      cloudflared: { type: "string", default: "cloudflared" },
      apply: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (parsed.values.help) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (parsed.positionals.length !== 1) throw new Error(`exactly one manifest path is required\n\n${usage()}`);
  if (parsed.values.env !== "beta" && !parsed.values["base-url"]) throw new Error("only --env beta is configured; use --base-url for another environment");
  return {
    file: parsed.positionals[0]!,
    apply: parsed.values.apply && !parsed.values["dry-run"],
    baseUrl: (parsed.values["base-url"] ?? betaBaseUrl).replace(/\/+$/, ""),
    cloudflared: parsed.values.cloudflared!,
    json: parsed.values.json,
  };
}

async function accessToken(cloudflared: string, url: string): Promise<string> {
  const { stdout } = await execFileAsync(cloudflared, ["access", "token", url], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const token = stdout.trim();
  if (!token || token.split(".").length !== 3) throw new Error("cloudflared did not return a valid Access token");
  return token;
}

async function api<T>(baseUrl: string, token: string, path = "", init: RequestInit = {}): Promise<T> {
  let response: Response | undefined;
  let networkError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: "application/json",
          "content-type": "application/json",
          "cf-access-token": token,
          ...init.headers,
        },
        redirect: "manual",
      });
      break;
    } catch (error) {
      networkError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  if (!response) {
    const cause = networkError instanceof Error && networkError.cause instanceof Error
      ? `: ${networkError.cause.message}`
      : "";
    throw new Error(`Memory API network request failed after 3 attempts${cause}`);
  }
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Memory API ${init.method ?? "GET"} ${path || "/"} returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return response.json() as Promise<T>;
}

function payload(entry: ImportPlanEntry): Record<string, unknown> {
  return {
    ...entry.desired,
    reason: "Synchronized by zxlab memory import CLI",
  };
}

async function execute(baseUrl: string, token: string, plan: ImportPlanEntry[]): Promise<void> {
  for (const entry of plan) {
    if (entry.action === "skip") continue;
    if (entry.action === "create") {
      await api(baseUrl, token, "/items", { method: "POST", body: JSON.stringify(payload(entry)) });
      continue;
    }
    await api(baseUrl, token, `/items/${encodeURIComponent(entry.existing!.id)}`, {
      method: "PATCH",
      body: JSON.stringify(payload(entry)),
    });
  }
}

function summary(plan: ImportPlanEntry[]) {
  return {
    create: plan.filter((entry) => entry.action === "create").length,
    update: plan.filter((entry) => entry.action === "update").length,
    skip: plan.filter((entry) => entry.action === "skip").length,
  };
}

function printPlan(plan: ImportPlanEntry[], applied: boolean): void {
  const counts = summary(plan);
  process.stdout.write(`${applied ? "Applied" : "Dry run"}: ${counts.create} create, ${counts.update} update, ${counts.skip} skip\n`);
  plan.forEach((entry, index) => {
    const detail = entry.changes.length ? ` (${entry.changes.join(", ")})` : "";
    process.stdout.write(`${String(index + 1).padStart(2, "0")} ${entry.action.padEnd(6)} ${entry.desired.namespace}/${entry.desired.kind}${detail} ${entry.desired.content}\n`);
  });
}

async function main(): Promise<void> {
  const cli = options();
  const manifest = parseMemoryManifest(await readFile(cli.file, "utf8"));
  const token = await accessToken(cli.cloudflared, `${cli.baseUrl}/items`);
  const before = await api<MemoryResponse>(cli.baseUrl, token, "/items");
  const plan = planMemoryImport(manifest.memories, before.memories);

  if (cli.apply) {
    await execute(cli.baseUrl, token, plan);
    const after = await api<MemoryResponse>(cli.baseUrl, token, "/items");
    const verification = planMemoryImport(manifest.memories, after.memories);
    if (verification.some((entry) => entry.action !== "skip")) throw new Error("post-import verification failed");
  }

  if (cli.json) {
    process.stdout.write(`${JSON.stringify({ profile: manifest.metadata, applied: cli.apply, summary: summary(plan), plan }, null, 2)}\n`);
  } else {
    printPlan(plan, cli.apply);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
