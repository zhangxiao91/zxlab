import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { syncObsidianNotes, type NoteCategory, type SyncResult } from "./obsidian-publisher.ts";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const defaultVault = "/Users/zhangyang/Library/Mobile Documents/iCloud~md~obsidian/Documents/my repo";

function parseArguments(): { category: NoteCategory; dryRun: boolean; acceptCovers: boolean } {
  const category = process.argv[2];
  if (category !== "technical" && category !== "journal") {
    throw new Error("Expected a category: technical or journal.");
  }
  return {
    category,
    dryRun: process.argv.includes("--dry-run"),
    acceptCovers: process.argv.includes("--accept-covers"),
  };
}

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return stdout.trim();
}

async function assertPublishingPreconditions(): Promise<void> {
  const branch = await git(["branch", "--show-current"]);
  if (branch !== "beta") throw new Error(`Publishing is restricted to beta; current branch is ${branch || "detached"}.`);
  const status = await git(["status", "--porcelain=v1"]);
  if (status) throw new Error("The worktree must be clean before publishing Obsidian notes.");
  await git(["pull", "--ff-only", "origin", "beta"]);
}

function parseStatusPaths(buffer: string): string[] {
  if (!buffer) return [];
  const fields = buffer.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const status = field.slice(0, 2);
    paths.push(field.slice(3));
    if (status.includes("R") || status.includes("C")) {
      index += 1;
      if (fields[index]) paths.push(fields[index]);
    }
  }
  return paths;
}

async function assertOnlyManagedChanges(result: SyncResult): Promise<void> {
  const { stdout } = await execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const allowed = new Set(result.changedPaths);
  const unexpected = parseStatusPaths(stdout).filter((item) => !allowed.has(item));
  if (unexpected.length) {
    throw new Error(`Unexpected files changed during publishing:\n${unexpected.map((item) => `- ${item}`).join("\n")}`);
  }
}

function printResult(result: SyncResult, dryRun: boolean): void {
  const label = dryRun ? "Dry run" : "Sync";
  console.log(`${label}: ${result.category}`);
  console.log(`Added: ${result.added.length ? result.added.join(", ") : "none"}`);
  console.log(`Updated: ${result.updated.length ? result.updated.join(", ") : "none"}`);
  console.log(`Removed: ${result.removed.length ? result.removed.join(", ") : "none"}`);
  console.log(`Covers accepted: ${result.covers.accepted.length ? result.covers.accepted.join(", ") : "none"}`);
  if (result.covers.pending.length) {
    console.log(`Cover previews awaiting review: ${result.covers.pending.join(", ")}`);
    console.log("Rerun this publish command with --accept-covers after reviewing them.");
  }
  if (result.covers.missing.length) {
    console.log(`Notes without a cover preview: ${result.covers.missing.join(", ")}`);
  }
  if (result.skipped.length) {
    console.log("Detected but not published:");
    for (const item of result.skipped) console.log(`- ${item.source} (${item.reason})`);
    console.log("Add YAML frontmatter with `publish: true` to publish a non-empty note.");
  }
  if (result.warnings.length) {
    console.log("Warnings:");
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }
}

async function main(): Promise<void> {
  const { category, dryRun, acceptCovers } = parseArguments();
  if (!dryRun) await assertPublishingPreconditions();

  const result = await syncObsidianNotes({
    category,
    dryRun,
    repoRoot,
    vaultRoot: process.env.OBSIDIAN_VAULT_PATH || defaultVault,
    acceptCovers,
    requireCovers: !dryRun,
  });
  printResult(result, dryRun);

  if (dryRun || result.changedPaths.length === 0) {
    if (!dryRun) console.log("No generated changes; nothing to publish.");
    return;
  }

  await assertOnlyManagedChanges(result);
  await execFileAsync("npm", ["run", "build"], { cwd: repoRoot, encoding: "utf8" });
  await assertOnlyManagedChanges(result);
  await git(["add", "-A", "--", ...result.changedPaths]);
  await git(["commit", "-m", `content(notes): publish ${category} updates`]);
  await git(["push", "origin", "beta"]);
  console.log("Published to origin/beta. Cloudflare deployment will follow the configured branch workflow.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
