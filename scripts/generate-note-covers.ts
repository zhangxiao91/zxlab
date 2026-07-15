import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBriefRequest,
  coverCachePaths,
  generateCoverPreview,
  readCoverPreview,
  type CoverApiConfig,
} from "./note-cover-pipeline.ts";
import { listCoverCandidates, type NoteCategory } from "./obsidian-publisher.ts";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const defaultVault = "/Users/zhangyang/Library/Mobile Documents/iCloud~md~obsidian/Documents/my repo";
const defaultEnvFile = path.resolve(repoRoot, "..", ".env");

function parseArguments(): { category: NoteCategory; dryRun: boolean; force: boolean; slug?: string } {
  const category = process.argv[2];
  if (category !== "technical" && category !== "journal") {
    throw new Error("Expected a category: technical or journal.");
  }
  const slugArgument = process.argv.find((argument) => argument.startsWith("--slug="));
  return {
    category,
    dryRun: process.argv.includes("--dry-run"),
    force: process.argv.includes("--force"),
    slug: slugArgument?.slice("--slug=".length),
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Cover generation requires ${name}.`);
  return value;
}

function loadApiConfig(): CoverApiConfig {
  const envFile = process.env.NOTES_COVER_ENV_PATH || defaultEnvFile;
  if (!existsSync(envFile)) throw new Error(`Cover environment file does not exist: ${envFile}`);
  loadEnvFile(envFile);
  return {
    image: {
      apiKey: requiredEnvironment("OPENAI_API_KEY"),
      baseUrl: requiredEnvironment("OPENAI_BASE_URL"),
      model: requiredEnvironment("OPENAI_IMAGE_MODEL"),
    },
    text: {
      apiKey: requiredEnvironment("OPENAI_TEXT_API_KEY"),
      baseUrl: requiredEnvironment("OPENAI_TEXT_BASE_URL"),
      model: requiredEnvironment("OPENAI_TEXT_MODEL"),
    },
  };
}

async function main(): Promise<void> {
  const { category, dryRun, force, slug } = parseArguments();
  const candidates = await listCoverCandidates({
    category,
    repoRoot,
    vaultRoot: process.env.OBSIDIAN_VAULT_PATH || defaultVault,
  });
  const selected = candidates.filter((candidate) => !slug || candidate.input.slug === slug);
  if (slug && selected.length === 0) throw new Error(`No published ${category} note found with slug "${slug}".`);

  const planned = [];
  for (const candidate of selected) {
    const cached = await readCoverPreview(repoRoot, candidate.input.slug);
    if (candidate.explicitCover) continue;
    if (!force && (candidate.generatedCover || cached)) continue;
    planned.push(candidate);
  }

  console.log(`Cover preview: ${category}`);
  if (!planned.length) {
    console.log("Nothing to generate. Existing explicit, accepted, or cached covers were preserved.");
    return;
  }

  if (dryRun) {
    console.log("Dry run: no environment file was loaded and no API was called.");
    for (const candidate of planned) {
      console.log(`\nWould generate: ${candidate.input.slug}`);
      console.log(`Target: ${coverCachePaths(repoRoot, candidate.input.slug).image}`);
      console.log("Visual brief request:");
      console.log(buildBriefRequest(candidate.input));
    }
    return;
  }

  const config = loadApiConfig();
  console.log(`Text model: ${config.text.model}`);
  console.log(`Image model: ${config.image.model}`);
  for (const candidate of planned) {
    console.log(`Generating: ${candidate.input.slug}`);
    const metadata = await generateCoverPreview({ input: candidate.input, repoRoot, config });
    const paths = coverCachePaths(repoRoot, candidate.input.slug);
    console.log(`Preview image: ${paths.image}`);
    console.log(`Visual brief: ${paths.metadata}`);
    console.log(`Alt: ${metadata.visualBrief.alt}`);
  }
  console.log("\nReview the previews, then publish with --accept-covers.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
