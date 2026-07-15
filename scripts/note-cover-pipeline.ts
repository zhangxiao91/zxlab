import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const COVER_PROMPT_VERSION = "zxlab-notes-v1";
export const COVER_CACHE_DIRECTORY = ".note-cover-cache";

export interface CoverInput {
  source: string;
  slug: string;
  title: string;
  description: string;
  category: "technical" | "journal";
  tags: string[];
  body: string;
}

export interface VisualBrief {
  coreIdea: string;
  visualMetaphor: string;
  primaryElements: string[];
  composition: string;
  mood: string;
  materials: string[];
  avoid: string[];
  alt: string;
}

export interface CoverPreviewMetadata {
  version: 1;
  slug: string;
  source: string;
  sourceHash: string;
  model: string;
  textModel: string;
  promptVersion: string;
  promptDigest: string;
  generatedAt: string;
  imagePath: string;
  visualBrief: VisualBrief;
  prompt: string;
}

export interface CoverApiConfig {
  image: { apiKey: string; baseUrl: string; model: string };
  text: { apiKey: string; baseUrl: string; model: string };
}

interface GenerateOptions {
  input: CoverInput;
  repoRoot: string;
  config: CoverApiConfig;
  fetchImpl?: typeof fetch;
  now?: string;
}

const CATEGORY_HINTS: Record<CoverInput["category"], string> = {
  technical: `Category direction:
Emphasize assembly, systems, layers, interfaces, boundaries, relationships,
flows, feedback loops, prototypes, and interacting components.`,
  journal: `Category direction:
Emphasize atmosphere, memory, quiet spaces, traces of time, light, absence,
distance, observation, and restrained ambiguity.`,
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function cleanBodyForCover(body: string, limit = 1800): string {
  const cleaned = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/^\s*\|.*\|\s*$/gm, " ")
    .replace(/!?(?:\[\[)([^\]|#^]+)(?:[^\]]*)\]\]/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*#{1,6}\s*/gm, "")
    .replace(/[>*_~]/g, " ");
  return compactText(cleaned).slice(0, limit).trim();
}

export function coverSourceHash(input: CoverInput): string {
  return sha256(JSON.stringify({
    title: input.title,
    description: input.description,
    category: input.category,
    tags: input.tags,
    excerpt: cleanBodyForCover(input.body),
  }));
}

function normalizeList(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value)) throw new Error(`Visual brief field "${field}" must be an array.`);
  const items = value.map(String).map(compactText).filter(Boolean).slice(0, maxItems);
  if (!items.length) throw new Error(`Visual brief field "${field}" cannot be empty.`);
  return items;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !compactText(value)) {
    throw new Error(`Visual brief field "${field}" must be a non-empty string.`);
  }
  return compactText(value);
}

export function parseVisualBrief(value: unknown): VisualBrief {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Visual brief response must be a JSON object.");
  }
  const brief = value as Record<string, unknown>;
  return {
    coreIdea: requiredString(brief.coreIdea, "coreIdea"),
    visualMetaphor: requiredString(brief.visualMetaphor, "visualMetaphor"),
    primaryElements: normalizeList(brief.primaryElements, "primaryElements", 3),
    composition: requiredString(brief.composition, "composition"),
    mood: requiredString(brief.mood, "mood"),
    materials: normalizeList(brief.materials, "materials", 4),
    avoid: normalizeList(brief.avoid, "avoid", 8),
    alt: requiredString(brief.alt, "alt"),
  };
}

export function buildBriefRequest(input: CoverInput): string {
  return `Turn this notebook article into a concise visual brief for an editorial cover.
Return only valid JSON with exactly these fields:
coreIdea (string), visualMetaphor (string), primaryElements (array, 1-3 items),
composition (string), mood (string), materials (array, 1-4 items),
avoid (array, 1-8 items), alt (string).

The alt field must be a concise Chinese description suitable for an HTML image.
Do not reproduce article prose. Do not introduce readable text, brands, public
figures, or sensitive personal details into the visual concept.

Title: ${input.title}
Description: ${input.description}
Category: ${input.category}
Tags: ${input.tags.join(", ") || "none"}
Article excerpt: ${cleanBodyForCover(input.body)}`;
}

export function buildCoverPrompt(
  input: CoverInput,
  brief: VisualBrief,
  visualIdentity: string,
): string {
  return [
    visualIdentity.trim(),
    `Article title:
${input.title}
Article summary:
${input.description}
Category:
${input.category}
Tags:
${input.tags.join(", ") || "none"}
Core idea:
${brief.coreIdea}
Visual metaphor:
${brief.visualMetaphor}
Primary visual elements:
${brief.primaryElements.map((item) => `- ${item}`).join("\n")}
Suggested materials:
${brief.materials.join(", ")}
Mood:
${brief.mood}
Composition:
${brief.composition}`,
    CATEGORY_HINTS[input.category],
    `Translate the article's underlying idea into one concise visual metaphor.
Do not attempt to illustrate every topic mentioned in the article.
Use no more than three primary visual elements.
The focal subject must remain clear at thumbnail size.
Keep all important elements inside the central 70% of the canvas.
Reserve generous negative space around the focal subject.
Keep the outer edges visually quiet for responsive cropping.
Do not create a literal screenshot or software interface.
Do not include:
- readable text, letters, or numbers
- logos, signatures, watermarks, stock tickers, or company branding
- floating code or circuit-board backgrounds
- glowing brains, humanoid robots, or generic AI heads
- neon cyberpunk scenes or dense dashboards
- photorealistic office workers or recognizable public figures
- fantasy landscapes or excessive tiny details
Article-specific exclusions:
${brief.avoid.map((item) => `- ${item}`).join("\n")}`,
  ].filter(Boolean).join("\n\n").trim();
}

function endpoint(baseUrl: string, resource: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/$/, "");
  url.pathname = `${basePath === "" ? "/v1" : basePath}/${resource.replace(/^\//, "")}`;
  return url.toString();
}

async function requestJson(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch,
): Promise<any> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const payload = await response.json().catch(() => undefined) as any;
      if (response.ok && !payload?.error) return payload;
      const message = typeof payload?.error?.message === "string" ? payload.error.message : `HTTP ${response.status}`;
      lastError = new Error(`API request failed: ${message}`);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 3) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      continue;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === 3 || !/fetch|network|timeout|abort/i.test(lastError.message)) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
  throw lastError ?? new Error("API request failed.");
}

async function generateVisualBrief(
  input: CoverInput,
  config: CoverApiConfig["text"],
  fetchImpl: typeof fetch,
): Promise<VisualBrief> {
  let payload: any;
  try {
    payload = await requestJson(endpoint(config.baseUrl, "chat/completions"), config.apiKey, {
      model: config.model,
      messages: [
        { role: "system", content: "You are an editorial art director. Return strict json only." },
        { role: "user", content: buildBriefRequest(input) },
      ],
      response_format: { type: "json_object" },
    }, fetchImpl);
  } catch (error) {
    throw new Error(`Visual brief generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rawContent = payload?.choices?.[0]?.message?.content;
  const content = typeof rawContent === "string"
    ? rawContent
    : Array.isArray(rawContent)
      ? rawContent.map((item) => typeof item?.text === "string" ? item.text : "").join("")
      : undefined;
  if (!content) throw new Error("Text model returned no visual brief content.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    throw new Error("Text model returned invalid JSON for the visual brief.");
  }
  return parseVisualBrief(parsed);
}

function assertWebp(bytes: Uint8Array): void {
  const header = Buffer.from(bytes.subarray(0, 12));
  if (header.length < 12 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error("Image model did not return a valid WebP file.");
  }
}

async function generateImage(
  prompt: string,
  config: CoverApiConfig["image"],
  fetchImpl: typeof fetch,
): Promise<Uint8Array> {
  let payload: any;
  try {
    payload = await requestJson(endpoint(config.baseUrl, "images/generations"), config.apiKey, {
      model: config.model,
      prompt,
      size: "1536x1024",
      quality: "medium",
      output_format: "webp",
      output_compression: 82,
      n: 1,
    }, fetchImpl);
  } catch (error) {
    throw new Error(`Cover image generation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const encoded = payload?.data?.[0]?.b64_json;
  let bytes: Uint8Array;
  if (typeof encoded === "string" && encoded) {
    bytes = Buffer.from(encoded, "base64");
  } else if (typeof payload?.data?.[0]?.url === "string") {
    const response = await fetchImpl(payload.data[0].url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Generated image download failed with HTTP ${response.status}.`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    const keys = Object.keys(payload?.data?.[0] ?? {}).join(", ") || "none";
    throw new Error(`Image model returned no image data (response fields: ${keys}).`);
  }
  assertWebp(bytes);
  return bytes;
}

export function coverCachePaths(repoRoot: string, slug: string): {
  directory: string;
  image: string;
  metadata: string;
} {
  const directory = path.join(repoRoot, COVER_CACHE_DIRECTORY, slug);
  return { directory, image: path.join(directory, "cover.webp"), metadata: path.join(directory, "metadata.json") };
}

export async function readCoverPreview(repoRoot: string, slug: string): Promise<CoverPreviewMetadata | undefined> {
  const paths = coverCachePaths(repoRoot, slug);
  if (!existsSync(paths.image) || !existsSync(paths.metadata)) return undefined;
  const metadata = JSON.parse(await readFile(paths.metadata, "utf8")) as CoverPreviewMetadata;
  if (metadata.version !== 1 || metadata.slug !== slug || metadata.imagePath !== "cover.webp") {
    throw new Error(`Cover preview metadata is invalid for ${slug}.`);
  }
  assertWebp(await readFile(paths.image));
  return metadata;
}

export async function generateCoverPreview(options: GenerateOptions): Promise<CoverPreviewMetadata> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const visualIdentity = await readFile(path.join(options.repoRoot, "prompts", "note-cover-system.md"), "utf8");
  const visualBrief = await generateVisualBrief(options.input, options.config.text, fetchImpl);
  const prompt = buildCoverPrompt(options.input, visualBrief, visualIdentity);
  const bytes = await generateImage(prompt, options.config.image, fetchImpl);
  const paths = coverCachePaths(options.repoRoot, options.input.slug);
  const metadata: CoverPreviewMetadata = {
    version: 1,
    slug: options.input.slug,
    source: options.input.source,
    sourceHash: coverSourceHash(options.input),
    model: options.config.image.model,
    textModel: options.config.text.model,
    promptVersion: COVER_PROMPT_VERSION,
    promptDigest: sha256(prompt),
    generatedAt: options.now ?? new Date().toISOString(),
    imagePath: "cover.webp",
    visualBrief,
    prompt,
  };

  await mkdir(paths.directory, { recursive: true });
  const imageTemp = `${paths.image}.tmp`;
  const metadataTemp = `${paths.metadata}.tmp`;
  try {
    await writeFile(imageTemp, bytes);
    await writeFile(metadataTemp, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    await rename(imageTemp, paths.image);
    await rename(metadataTemp, paths.metadata);
  } finally {
    await rm(imageTemp, { force: true });
    await rm(metadataTemp, { force: true });
  }
  return metadata;
}
