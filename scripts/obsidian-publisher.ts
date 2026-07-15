import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type NoteCategory = "technical" | "journal";

export interface ManifestEntry {
  source: string;
  category: NoteCategory;
  slug: string;
  title: string;
  aliases: string[];
  publishedAt: string;
  output: string;
  assets: string[];
  digest: string;
}

export interface SyncManifest {
  version: 1;
  notes: Record<string, ManifestEntry>;
}

export interface InternalReference {
  targetKey: string;
  label: string;
  targetSlug?: string;
  targetTitle?: string;
  url?: string;
}

export interface ExternalReference {
  label: string;
  domain: string;
  url: string;
}

export interface ReferenceNode {
  slug: string;
  title: string;
  sourceKey: string;
  outgoing: InternalReference[];
  backlinks: Array<{ slug: string; title: string; url: string }>;
  external: ExternalReference[];
  unpublished: Array<{ targetKey: string; label: string }>;
}

export interface ReferenceGraph {
  version: 1;
  nodes: Record<string, ReferenceNode>;
}

export interface SyncOptions {
  category: NoteCategory;
  vaultRoot: string;
  repoRoot: string;
  dryRun?: boolean;
  today?: string;
}

export interface SyncResult {
  category: NoteCategory;
  added: string[];
  updated: string[];
  removed: string[];
  skipped: Array<{ source: string; reason: "missing publish: true" | "empty note" }>;
  warnings: string[];
  changedPaths: string[];
  manifest: SyncManifest;
  graph: ReferenceGraph;
}

interface SourceNote {
  key: string;
  absolutePath: string;
  category: NoteCategory;
  body: string;
  data: Record<string, unknown>;
  title: string;
  aliases: string[];
  publish: boolean;
}

interface PlannedAsset {
  publicPath: string;
  repoPath: string;
  bytes: Uint8Array;
  digest: string;
}

interface TransformResult {
  markdown: string;
  outgoing: InternalReference[];
  external: ExternalReference[];
  unpublished: Array<{ targetKey: string; label: string }>;
  assets: PlannedAsset[];
  warnings: string[];
}

const JOURNAL_DIRECTORY = "50-其他/杂谈";
const SKIPPED_DIRECTORIES = new Set([".git", ".obsidian", "templates"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);
const SITE_URL = "https://zx-dx.xyz";

function normalizeRelative(value: string): string {
  return value.split(path.sep).join("/").replace(/^\.\//, "");
}

function categoryForKey(key: string): NoteCategory {
  return key === JOURNAL_DIRECTORY || key.startsWith(`${JOURNAL_DIRECTORY}/`)
    ? "journal"
    : "technical";
}

function shouldWalkDirectory(name: string): boolean {
  return !SKIPPED_DIRECTORIES.has(name) && !name.startsWith(".");
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (shouldWalkDirectory(entry.name)) await walk(path.join(current, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        results.push(path.join(current, entry.name));
      }
    }
  }

  await walk(root);
  return results.sort((a, b) => a.localeCompare(b));
}

export function parseFrontmatter(source: string): {
  data: Record<string, unknown>;
  body: string;
} {
  if (!source.startsWith("---\n") && !source.startsWith("---\r\n")) {
    return { data: {}, body: source };
  }

  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("Frontmatter is missing a closing --- delimiter.");
  const parsed = parseYaml(match[1]) ?? {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Frontmatter must be a YAML object.");
  }
  return { data: parsed as Record<string, unknown>, body: source.slice(match[0].length) };
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function firstHeading(body: string): string | undefined {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function stripMarkdown(value: string): string {
  return value
    .replace(/!?(?:\[\[)([^\]|#^]+)(?:[^\]]*)\]\]/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>#~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function descriptionFromBody(body: string): string {
  const withoutFences = body.replace(/```[\s\S]*?```/g, "");
  const paragraphs = withoutFences.split(/\r?\n\s*\r?\n/);
  for (const paragraph of paragraphs) {
    if (/^\s*(#|[-*+]\s|\d+\.\s|\||>|!\[)/.test(paragraph)) continue;
    const cleaned = stripMarkdown(paragraph);
    if (cleaned) return cleaned.length > 160 ? `${cleaned.slice(0, 157).trimEnd()}...` : cleaned;
  }
  return "A note published from the working notebook.";
}

export function slugifyNote(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\\/]+/g, "-")
    .replace(/[\s_]+/g, "-")
    .replace(/[^\p{Letter}\p{Number}-]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized) throw new Error(`Cannot derive a slug from "${value}".`);
  return normalized;
}

function headingSlug(value: string): string {
  return slugifyNote(value.replace(/^\^/, "block-"));
}

async function scanVault(vaultRoot: string): Promise<Map<string, SourceNote>> {
  if (!existsSync(vaultRoot)) throw new Error(`Obsidian vault does not exist: ${vaultRoot}`);
  const notes = new Map<string, SourceNote>();

  for (const absolutePath of await listMarkdownFiles(vaultRoot)) {
    const key = normalizeRelative(path.relative(vaultRoot, absolutePath));
    const raw = await readFile(absolutePath, "utf8");
    const { data, body } = parseFrontmatter(raw);
    const title = String(data.title || firstHeading(body) || path.basename(key, path.extname(key))).trim();
    notes.set(key, {
      key,
      absolutePath,
      category: categoryForKey(key),
      body,
      data,
      title,
      aliases: stringArray(data.aliases),
      publish: data.publish === true && body.trim().length > 0,
    });
  }

  return notes;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback;
  return JSON.parse(await readFile(file, "utf8")) as T;
}

function resolverKeys(note: SourceNote): string[] {
  const withoutExtension = note.key.replace(/\.md$/i, "");
  return [
    note.key,
    withoutExtension,
    path.posix.basename(withoutExtension),
    note.title,
    ...note.aliases,
  ].map((item) => item.normalize("NFKC").toLowerCase());
}

function buildSourceResolver(notes: Map<string, SourceNote>): Map<string, SourceNote[]> {
  const resolver = new Map<string, SourceNote[]>();
  for (const note of notes.values()) {
    for (const key of resolverKeys(note)) {
      const matches = resolver.get(key) ?? [];
      if (!matches.includes(note)) matches.push(note);
      resolver.set(key, matches);
    }
  }
  return resolver;
}

function resolveNoteTarget(
  rawTarget: string,
  source: SourceNote,
  resolver: Map<string, SourceNote[]>,
): SourceNote | undefined {
  const target = rawTarget.split("#", 1)[0].trim();
  const normalized = target.normalize("NFKC").toLowerCase();
  const relative = normalizeRelative(
    path.posix.normalize(path.posix.join(path.posix.dirname(source.key), target)),
  ).replace(/\.md$/i, "");
  const candidates = [normalized, normalized.replace(/\.md$/i, ""), relative.toLowerCase()];
  for (const candidate of candidates) {
    const matches = resolver.get(candidate);
    if (matches?.length === 1) return matches[0];
    if (matches && matches.length > 1) {
      throw new Error(`Ambiguous Wiki Link "${rawTarget}" in ${source.key}.`);
    }
  }
  return undefined;
}

function parseWikiTarget(value: string): { target: string; label: string; fragment?: string } {
  const [targetPart, alias] = value.split("|", 2);
  const hashIndex = targetPart.indexOf("#");
  const target = (hashIndex >= 0 ? targetPart.slice(0, hashIndex) : targetPart).trim();
  const fragmentRaw = hashIndex >= 0 ? targetPart.slice(hashIndex + 1).trim() : undefined;
  const fallbackLabel = fragmentRaw?.replace(/^\^/, "") || path.posix.basename(target) || target;
  return {
    target,
    label: (alias || fallbackLabel).trim(),
    fragment: fragmentRaw ? headingSlug(fragmentRaw) : undefined,
  };
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function canonicalNoteUrl(slug: string, fragment?: string): string {
  return `${SITE_URL}/notes/${encodeURIComponent(slug)}${fragment ? `#${fragment}` : ""}`;
}

function relativeNoteUrl(slug: string, fragment?: string): string {
  return `/notes/${encodeURIComponent(slug)}${fragment ? `#${fragment}` : ""}`;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function assetFilename(original: string, index: number): string {
  const extension = path.extname(original).toLowerCase();
  const base = slugifyNote(path.basename(original, extension) || `image-${index + 1}`);
  return `${String(index + 1).padStart(2, "0")}-${base}${extension || ".png"}`;
}

async function findAttachment(vaultRoot: string, source: SourceNote, target: string): Promise<string> {
  const cleanTarget = decodeURIComponent(target).split("#", 1)[0];
  const direct = [
    path.resolve(path.dirname(source.absolutePath), cleanTarget),
    path.resolve(vaultRoot, cleanTarget),
    path.resolve(vaultRoot, "assets", cleanTarget),
  ];
  for (const candidate of direct) {
    if (existsSync(candidate) && (await stat(candidate)).isFile()) return candidate;
  }

  const basename = path.basename(cleanTarget);
  const matches: string[] = [];
  async function walk(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (shouldWalkDirectory(entry.name)) await walk(path.join(current, entry.name));
      } else if (entry.isFile() && entry.name === basename) {
        matches.push(path.join(current, entry.name));
      }
    }
  }
  await walk(vaultRoot);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Attachment "${target}" is ambiguous in ${source.key}.`);
  throw new Error(`Attachment "${target}" referenced by ${source.key} was not found.`);
}

function decodeDataUri(uri: string): { extension: string; bytes: Uint8Array } {
  const match = uri.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
  if (!match) throw new Error("Only base64 image data URIs are supported.");
  const extensions: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/avif": ".avif",
  };
  const extension = extensions[match[1]];
  if (!extension) throw new Error(`Unsupported data URI type: ${match[1]}`);
  return { extension, bytes: Buffer.from(match[2], "base64") };
}

async function transformMarkdown(args: {
  source: SourceNote;
  slug: string;
  vaultRoot: string;
  repoRoot: string;
  resolver: Map<string, SourceNote[]>;
  entries: Record<string, ManifestEntry>;
}): Promise<TransformResult> {
  const { source, slug, vaultRoot, repoRoot, resolver, entries } = args;
  const processor = unified().use(remarkParse).use(remarkStringify, {
    bullet: "-",
    fences: true,
    listItemIndent: "one",
  });
  const tree = processor.parse(source.body) as any;
  const outgoing: InternalReference[] = [];
  const external: ExternalReference[] = [];
  const unpublished: Array<{ targetKey: string; label: string }> = [];
  const assets: PlannedAsset[] = [];
  const warnings: string[] = [];

  const activeBySource = new Map(Object.values(entries).map((entry) => [entry.source, entry]));

  async function addAsset(target: string, alt: string, dataUri?: string): Promise<any> {
    let extension = path.extname(target).toLowerCase();
    let bytes: Uint8Array;
    if (dataUri) {
      const decoded = decodeDataUri(dataUri);
      extension = decoded.extension;
      bytes = decoded.bytes;
    } else {
      const sourcePath = await findAttachment(vaultRoot, source, target);
      extension = path.extname(sourcePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(extension)) {
        throw new Error(`Unsupported image attachment "${target}" in ${source.key}.`);
      }
      bytes = await readFile(sourcePath);
    }
    const filename = assetFilename(`${path.basename(target, path.extname(target)) || "image"}${extension}`, assets.length);
    const repoPath = normalizeRelative(path.join("public", "assets", "notes", slug, filename));
    const publicPath = `/${normalizeRelative(path.join("assets", "notes", slug, filename))}`;
    assets.push({ repoPath, publicPath, bytes, digest: digest(bytes) });
    return { type: "image", url: publicPath, alt: alt || path.basename(target, path.extname(target)) };
  }

  async function convertText(value: string): Promise<any[]> {
    const nodes: any[] = [];
    const regex = /(!?)\[\[([^\]]+)\]\]|https?:\/\/[^\s<>]+/g;
    let cursor = 0;
    for (const match of value.matchAll(regex)) {
      const index = match.index ?? 0;
      if (index > cursor) nodes.push({ type: "text", value: value.slice(cursor, index) });
      if (match[0].startsWith("http")) {
        const url = match[0].replace(/[.,;:!?]+$/, "");
        nodes.push({ type: "link", url, children: [{ type: "text", value: url }] });
        external.push({ label: url, domain: new URL(url).hostname, url });
        const trailing = match[0].slice(url.length);
        if (trailing) nodes.push({ type: "text", value: trailing });
      } else {
        const embedded = match[1] === "!";
        const parsed = parseWikiTarget(match[2]);
        const targetNote = resolveNoteTarget(parsed.target, source, resolver);
        if (embedded && (!targetNote || IMAGE_EXTENSIONS.has(path.extname(parsed.target).toLowerCase()))) {
          nodes.push(await addAsset(parsed.target, parsed.label));
        } else if (targetNote) {
          const targetEntry = activeBySource.get(targetNote.key);
          if (targetEntry) {
            const url = relativeNoteUrl(targetEntry.slug, parsed.fragment);
            nodes.push({ type: "link", url, children: [{ type: "text", value: parsed.label }] });
            outgoing.push({
              targetKey: targetNote.key,
              targetSlug: targetEntry.slug,
              targetTitle: targetEntry.title,
              label: parsed.label,
              url: canonicalNoteUrl(targetEntry.slug, parsed.fragment),
            });
          } else {
            nodes.push({ type: "text", value: parsed.label });
            unpublished.push({ targetKey: targetNote.key, label: parsed.label });
            warnings.push(`${source.key}: "${parsed.label}" points to an unpublished note.`);
          }
        } else {
          nodes.push({ type: "text", value: parsed.label });
          unpublished.push({ targetKey: parsed.target, label: parsed.label });
          warnings.push(`${source.key}: Wiki Link "${parsed.target}" could not be resolved.`);
        }
      }
      cursor = index + match[0].length;
    }
    if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });

    const finalNodes: any[] = [];
    for (const node of nodes) {
      if (node.type === "text") {
        const blockMatch = node.value.match(/^(.*?)(?:\s+)?\^([A-Za-z0-9-]+)$/);
        if (blockMatch) {
          if (blockMatch[1]) finalNodes.push({ type: "text", value: blockMatch[1] });
          finalNodes.push({ type: "html", value: `<span id="block-${blockMatch[2]}"></span>` });
          continue;
        }
      }
      finalNodes.push(node);
    }
    return finalNodes;
  }

  async function walk(node: any): Promise<void> {
    if (!node || node.type === "code" || node.type === "inlineCode" || node.type === "html") return;
    if (node.type === "link" && isHttpUrl(node.url)) {
      const label = stripMarkdown((node.children ?? []).map((child: any) => child.value ?? "").join("")) || node.url;
      external.push({ label, domain: new URL(node.url).hostname, url: node.url });
    }
    if (node.type === "image") {
      if (node.url.startsWith("data:image/")) {
        Object.assign(node, await addAsset("embedded-image.png", node.alt ?? "", node.url));
      } else if (!isHttpUrl(node.url) && !node.url.startsWith("/")) {
        Object.assign(node, await addAsset(node.url, node.alt ?? ""));
      }
      return;
    }
    if (!Array.isArray(node.children)) return;
    const nextChildren: any[] = [];
    for (const child of node.children) {
      if (child.type === "text") nextChildren.push(...(await convertText(child.value)));
      else {
        await walk(child);
        nextChildren.push(child);
      }
    }
    node.children = nextChildren;
  }

  await walk(tree);
  if (tree.children?.[0]?.type === "heading" && tree.children[0].depth === 1) {
    const heading = stripMarkdown(tree.children[0].children?.map((child: any) => child.value ?? "").join("") ?? "");
    if (heading === source.title) tree.children.shift();
  }

  return {
    markdown: String(processor.stringify(tree)).replace(/\n{3,}/g, "\n\n").trim() + "\n",
    outgoing: uniqueBy(outgoing, (item) => `${item.targetKey}|${item.url}`),
    external: uniqueBy(external, (item) => item.url),
    unpublished: uniqueBy(unpublished, (item) => `${item.targetKey}|${item.label}`),
    assets,
    warnings: uniqueBy(warnings, (item) => item),
  };
}

function outputFrontmatter(source: SourceNote, entry: ManifestEntry, description: string): string {
  const data: Record<string, unknown> = {
    title: entry.title,
    description,
    publishedAt: entry.publishedAt,
    category: entry.category,
    tags: stringArray(source.data.tags),
    draft: false,
  };
  for (const key of ["cover", "coverAlt", "accent"] as const) {
    if (typeof source.data[key] === "string" && source.data[key]) data[key] = source.data[key];
  }
  return `---\n${stringifyYaml(data).trim()}\n---\n\n`;
}

function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function removeIfExists(absolutePath: string, dryRun: boolean): Promise<void> {
  if (!existsSync(absolutePath) || dryRun) return;
  await rm(absolutePath, { recursive: true, force: true });
}

async function writeText(absolutePath: string, content: string, dryRun: boolean): Promise<void> {
  if (dryRun) return;
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
}

function emptyManifest(): SyncManifest {
  return { version: 1, notes: {} };
}

function emptyGraph(): ReferenceGraph {
  return { version: 1, nodes: {} };
}

export async function syncObsidianNotes(options: SyncOptions): Promise<SyncResult> {
  const dryRun = options.dryRun ?? false;
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const manifestPath = path.join(options.repoRoot, "scripts", "obsidian-notes-manifest.json");
  const graphPath = path.join(options.repoRoot, "src", "data", "note-references.json");
  const previousManifest = await readJson<SyncManifest>(manifestPath, emptyManifest());
  const previousGraph = await readJson<ReferenceGraph>(graphPath, emptyGraph());
  const manifest: SyncManifest = JSON.parse(JSON.stringify(previousManifest));
  const sourceNotes = await scanVault(options.vaultRoot);
  const resolver = buildSourceResolver(sourceNotes);
  const selected = [...sourceNotes.values()].filter((note) => note.category === options.category && note.publish);
  const selectedSources = new Set(selected.map((note) => note.key));
  const previouslyManagedSources = new Set(
    Object.values(previousManifest.notes)
      .filter((entry) => entry.category === options.category)
      .map((entry) => entry.source),
  );
  const skipped = [...sourceNotes.values()]
    .filter((note) => note.category === options.category && !note.publish && !previouslyManagedSources.has(note.key))
    .map((note) => ({
      source: note.key,
      reason: (note.body.trim().length === 0 ? "empty note" : "missing publish: true") as
        | "missing publish: true"
        | "empty note",
    }));
  const removedEntries = Object.values(manifest.notes).filter(
    (entry) => entry.category === options.category && !selectedSources.has(entry.source),
  );
  const removed: string[] = [];
  const changedPaths = new Set<string>();

  for (const entry of removedEntries) {
    removed.push(entry.slug);
    delete manifest.notes[entry.slug];
    changedPaths.add(entry.output);
    for (const asset of entry.assets) changedPaths.add(asset);
  }

  const slugOwners = new Map<string, string>();
  for (const entry of Object.values(manifest.notes)) slugOwners.set(entry.slug, entry.source);

  for (const note of selected) {
    const previous = Object.values(previousManifest.notes).find((entry) => entry.source === note.key);
    const slug = slugifyNote(String(note.data.slug || previous?.slug || path.basename(note.key, ".md")));
    const owner = slugOwners.get(slug);
    if (owner && owner !== note.key) throw new Error(`Slug "${slug}" is already used by ${owner}.`);
    const output = normalizeRelative(path.join("src", "content", "notes", `${slug}.md`));
    if (existsSync(path.join(options.repoRoot, output)) && !previous) {
      throw new Error(`Refusing to overwrite unmanaged note: ${output}`);
    }
    manifest.notes[slug] = {
      source: note.key,
      category: options.category,
      slug,
      title: note.title,
      aliases: note.aliases,
      publishedAt: String(note.data.publishedAt || previous?.publishedAt || today),
      output,
      assets: previous?.assets ?? [],
      digest: previous?.digest ?? "",
    };
    slugOwners.set(slug, note.key);
  }

  const transformedBySlug = new Map<string, TransformResult>();
  const renderedBySlug = new Map<string, string>();
  const warnings: string[] = [];

  for (const entry of Object.values(manifest.notes)) {
    const note = sourceNotes.get(entry.source);
    if (!note) continue;
    const transformed = await transformMarkdown({
      source: note,
      slug: entry.slug,
      vaultRoot: options.vaultRoot,
      repoRoot: options.repoRoot,
      resolver,
      entries: manifest.notes,
    });
    transformedBySlug.set(entry.slug, transformed);
    warnings.push(...transformed.warnings);
    if (note.category === options.category && selectedSources.has(note.key)) {
      const description = String(note.data.description || descriptionFromBody(transformed.markdown));
      const rendered = `${outputFrontmatter(note, entry, description)}<!-- Generated from Obsidian. Edit the source note, not this file. -->\n\n${transformed.markdown}`;
      renderedBySlug.set(entry.slug, rendered);
      entry.assets = transformed.assets.map((asset) => asset.repoPath);
      entry.digest = digest(rendered + JSON.stringify(transformed.assets.map((asset) => [asset.repoPath, asset.digest])));
    }
  }

  const graph: ReferenceGraph = { version: 1, nodes: {} };
  for (const entry of Object.values(manifest.notes)) {
    const transformed = transformedBySlug.get(entry.slug);
    const oldNode = previousGraph.nodes[entry.slug];
    graph.nodes[entry.slug] = {
      slug: entry.slug,
      title: entry.title,
      sourceKey: entry.source,
      outgoing: transformed?.outgoing ?? oldNode?.outgoing ?? [],
      backlinks: [],
      external: transformed?.external ?? oldNode?.external ?? [],
      unpublished: transformed?.unpublished ?? oldNode?.unpublished ?? [],
    };
  }
  for (const node of Object.values(graph.nodes)) {
    for (const reference of node.outgoing) {
      if (!reference.targetSlug || !graph.nodes[reference.targetSlug]) continue;
      graph.nodes[reference.targetSlug].backlinks.push({
        slug: node.slug,
        title: node.title,
        url: canonicalNoteUrl(node.slug),
      });
    }
  }
  for (const node of Object.values(graph.nodes)) {
    node.backlinks = uniqueBy(node.backlinks, (item) => item.slug).sort((a, b) => a.title.localeCompare(b.title));
  }

  // Apply filesystem mutations only after every selected note and reference has
  // parsed successfully. This keeps strict conversion failures transactional.
  for (const entry of removedEntries) {
    await removeIfExists(path.join(options.repoRoot, entry.output), dryRun);
    await removeIfExists(path.join(options.repoRoot, "public", "assets", "notes", entry.slug), dryRun);
  }

  const added: string[] = [];
  const updated: string[] = [];
  for (const [slug, rendered] of renderedBySlug) {
    const entry = manifest.notes[slug];
    const previous = previousManifest.notes[slug];
    const changed = !previous || previous.digest !== entry.digest;
    if (!changed) continue;
    (previous ? updated : added).push(slug);
    changedPaths.add(entry.output);
    for (const asset of previous?.assets ?? []) changedPaths.add(asset);
    for (const asset of entry.assets) changedPaths.add(asset);
    await removeIfExists(path.join(options.repoRoot, "public", "assets", "notes", slug), dryRun);
    await writeText(path.join(options.repoRoot, entry.output), rendered, dryRun);
    if (!dryRun) {
      for (const asset of transformedBySlug.get(slug)!.assets) {
        const absoluteAsset = path.join(options.repoRoot, asset.repoPath);
        await mkdir(path.dirname(absoluteAsset), { recursive: true });
        await writeFile(absoluteAsset, asset.bytes);
      }
    }
  }

  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const graphJson = `${JSON.stringify(graph, null, 2)}\n`;
  const previousManifestJson = `${JSON.stringify(previousManifest, null, 2)}\n`;
  const previousGraphJson = `${JSON.stringify(previousGraph, null, 2)}\n`;
  if (manifestJson !== previousManifestJson) {
    changedPaths.add(normalizeRelative(path.relative(options.repoRoot, manifestPath)));
    await writeText(manifestPath, manifestJson, dryRun);
  }
  if (graphJson !== previousGraphJson) {
    changedPaths.add(normalizeRelative(path.relative(options.repoRoot, graphPath)));
    await writeText(graphPath, graphJson, dryRun);
  }

  return {
    category: options.category,
    added,
    updated,
    removed,
    skipped,
    warnings: uniqueBy(warnings, (item) => item),
    changedPaths: [...changedPaths].sort(),
    manifest,
    graph,
  };
}

export function referenceGraphForSlug(graph: ReferenceGraph, slug: string): ReferenceNode | undefined {
  return graph.nodes[slug];
}
