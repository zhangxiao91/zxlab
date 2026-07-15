import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  listCoverCandidates,
  parseFrontmatter,
  slugifyNote,
  syncObsidianNotes,
} from "./obsidian-publisher.ts";
import {
  cleanBodyForCover,
  generateCoverPreview,
  type CoverApiConfig,
} from "./note-cover-pipeline.ts";

async function fixture(): Promise<{ root: string; repo: string; vault: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "zxlab-notes-"));
  const repo = path.join(root, "repo");
  const vault = path.join(root, "vault");
  await mkdir(path.join(repo, "src", "content", "notes"), { recursive: true });
  await mkdir(path.join(repo, "src", "data"), { recursive: true });
  await mkdir(path.join(repo, "scripts"), { recursive: true });
  await mkdir(path.join(repo, "prompts"), { recursive: true });
  await mkdir(path.join(vault, "50-其他", "杂谈"), { recursive: true });
  await mkdir(path.join(vault, "assets"), { recursive: true });
  await writeFile(path.join(repo, "scripts", "obsidian-notes-manifest.json"), '{"version":1,"notes":{}}\n');
  await writeFile(path.join(repo, "src", "data", "note-references.json"), '{"version":1,"nodes":{}}\n');
  await writeFile(path.join(repo, "prompts", "note-cover-system.md"), "Quiet geometric editorial identity.");
  return { root, repo, vault };
}

test("frontmatter and unicode slugs are deterministic", () => {
  const parsed = parseFrontmatter("---\npublish: true\ntags: [Astro]\n---\n\n# 标题\n");
  assert.equal(parsed.data.publish, true);
  assert.deepEqual(parsed.data.tags, ["Astro"]);
  assert.equal(slugifyNote("快 与慢"), "快-与慢");
});

test("category sync preserves references, sources, assets, and stable dates", async () => {
  const { repo, vault } = await fixture();
  await writeFile(path.join(vault, "assets", "diagram.png"), Buffer.from("image"));
  await writeFile(
    path.join(vault, "50-其他", "杂谈", "慢下来.md"),
    "---\npublish: true\naliases: [慢] \n---\n\n# 慢下来\n\n日常观察。 ^moment\n",
  );
  await writeFile(
    path.join(vault, "技术记录.md"),
    [
      "---",
      "publish: true",
      "tags: [Astro]",
      "---",
      "",
      "# 技术记录",
      "",
      "参见 [[慢下来|这篇杂谈]]、[[慢下来#^moment|那个瞬间]] 与 [Astro](https://astro.build/)。",
      "",
      "代码中的地址不应成为来源：`https://example.com/code`。",
      "",
      "![[diagram.png]]",
      "",
      "![pixel](data:image/png;base64,aGVsbG8=)",
      "",
      "可定位内容。 ^anchor",
    ].join("\n"),
  );
  await utimes(path.join(vault, "技术记录.md"), new Date("2025-12-31T12:00:00Z"), new Date("2025-12-31T12:00:00Z"));

  await syncObsidianNotes({ category: "journal", repoRoot: repo, vaultRoot: vault, today: "2026-01-01" });
  const technical = await syncObsidianNotes({ category: "technical", repoRoot: repo, vaultRoot: vault, today: "2026-01-02" });
  assert.deepEqual(technical.added, ["技术记录"]);
  assert.equal(technical.graph.nodes["技术记录"].outgoing[0].targetSlug, "慢下来");
  assert.match(technical.graph.nodes["技术记录"].outgoing[1].url ?? "", /#block-moment$/);
  assert.deepEqual(technical.graph.nodes["技术记录"].external.map((item) => item.url), ["https://astro.build/"]);
  assert.equal(technical.graph.nodes["慢下来"].backlinks[0].slug, "技术记录");

  const output = await readFile(path.join(repo, "src", "content", "notes", "技术记录.md"), "utf8");
  assert.match(output, /publishedAt: 2026-01-02/);
  assert.match(output, /updatedAt: 2025-12-31/);
  assert.match(output, /\/notes\/%E6%85%A2%E4%B8%8B%E6%9D%A5/);
  assert.match(output, /\/assets\/notes\/技术记录\/01-diagram.png/);
  assert.match(output, /\/assets\/notes\/技术记录\/02-embedded-image.png/);
  assert.match(output, /id="block-anchor"/);

  await writeFile(path.join(vault, "assets", "diagram.png"), Buffer.from("updated-image"));
  const assetUpdate = await syncObsidianNotes({ category: "technical", repoRoot: repo, vaultRoot: vault, today: "2026-01-03" });
  assert.deepEqual(assetUpdate.updated, ["技术记录"]);

  await writeFile(path.join(vault, "技术记录.md"), output.replace("publish: true", "publish: false"));
  const removed = await syncObsidianNotes({ category: "technical", repoRoot: repo, vaultRoot: vault, today: "2026-01-04" });
  assert.deepEqual(removed.removed, ["技术记录"]);
});

test("dry runs report changes without writing generated files", async () => {
  const { repo, vault } = await fixture();
  await writeFile(path.join(vault, "预览.md"), "---\npublish: true\n---\n\n# 预览\n\n只做预览。\n");
  const result = await syncObsidianNotes({
    category: "technical",
    repoRoot: repo,
    vaultRoot: vault,
    today: "2026-02-01",
    dryRun: true,
  });
  assert.deepEqual(result.added, ["预览"]);
  assert.equal(existsSync(path.join(repo, "src", "content", "notes", "预览.md")), false);
});

test("new notes without an explicit publish flag are reported as skipped", async () => {
  const { repo, vault } = await fixture();
  await writeFile(path.join(vault, "50-其他", "杂谈", "私密草稿.md"), "# 私密草稿\n\n尚未公开。\n");
  await writeFile(path.join(vault, "50-其他", "杂谈", "空白.md"), "");

  const result = await syncObsidianNotes({
    category: "journal",
    repoRoot: repo,
    vaultRoot: vault,
    dryRun: true,
  });

  assert.deepEqual(result.added, []);
  assert.deepEqual(result.skipped, [
    { source: "50-其他/杂谈/私密草稿.md", reason: "missing publish: true" },
    { source: "50-其他/杂谈/空白.md", reason: "empty note" },
  ]);
});

test("unpublished links remain text and are retained as relationship metadata", async () => {
  const { repo, vault } = await fixture();
  const draftPath = path.join(vault, "50-其他", "杂谈", "草稿.md");
  await writeFile(draftPath, "# 草稿\n\n未发布。\n");
  await writeFile(path.join(vault, "公开.md"), "---\npublish: true\n---\n\n# 公开\n\n阅读 [[草稿|未来文章]]。\n");
  const result = await syncObsidianNotes({ category: "technical", repoRoot: repo, vaultRoot: vault, today: "2026-02-01" });
  assert.deepEqual(result.graph.nodes["公开"].unpublished, [{ targetKey: "50-其他/杂谈/草稿.md", label: "未来文章" }]);
  const output = await readFile(path.join(repo, "src", "content", "notes", "公开.md"), "utf8");
  assert.match(output, /未来文章/);
  assert.doesNotMatch(output, /href/);

  await writeFile(draftPath, "---\npublish: true\n---\n\n# 草稿\n\n现在发布。\n");
  const upgraded = await syncObsidianNotes({ category: "journal", repoRoot: repo, vaultRoot: vault, today: "2026-02-02" });
  assert.equal(upgraded.graph.nodes["公开"].outgoing[0].targetSlug, "草稿");
  assert.equal(upgraded.graph.nodes["草稿"].backlinks[0].slug, "公开");
});

test("missing attachments fail without generating partial content", async () => {
  const { repo, vault } = await fixture();
  await writeFile(path.join(vault, "图片.md"), "---\npublish: true\n---\n\n# 图片\n\n![[missing.png]]\n");
  await assert.rejects(
    syncObsidianNotes({ category: "technical", repoRoot: repo, vaultRoot: vault, today: "2026-02-01" }),
    /was not found/,
  );
});

test("cover input cleaning removes code, tables, and URLs", () => {
  const cleaned = cleanBodyForCover([
    "正文 [说明](https://example.com/page)",
    "`inline()`",
    "```ts",
    "const secret = true;",
    "```",
    "| A | B |",
    "| - | - |",
  ].join("\n"));
  assert.equal(cleaned, "正文 说明");
});

test("cover preview uses separate text and image credentials and can be accepted", async () => {
  const { repo, vault } = await fixture();
  await writeFile(
    path.join(vault, "50-其他", "杂谈", "封面测试.md"),
    "---\npublish: true\ntags: [观察]\n---\n\n# 封面测试\n\n关于时间与空间的观察。\n",
  );
  const [candidate] = await listCoverCandidates({ category: "journal", repoRoot: repo, vaultRoot: vault });
  const config: CoverApiConfig = {
    text: { apiKey: "text-secret", baseUrl: "https://text.example/v1", model: "gpt-5.5" },
    image: { apiKey: "image-secret", baseUrl: "https://image.example/v1", model: "gpt-image-2" },
  };
  const calls: Array<{ url: string; authorization: string; body: any }> = [];
  const webp = Buffer.from("RIFF0000WEBP");
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://images.example/cover.webp") {
      return new Response(webp, { status: 200, headers: { "Content-Type": "image/webp" } });
    }
    const authorization = String((init?.headers as Record<string, string>).Authorization);
    const body = JSON.parse(String(init?.body));
    calls.push({ url, authorization, body });
    if (url.endsWith("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        coreIdea: "时间与空间的张力",
        visualMetaphor: "两块错位的半透明石材",
        primaryElements: ["石材", "光线"],
        composition: "非对称中央构图",
        mood: "安静克制",
        materials: ["石材", "磨砂玻璃"],
        avoid: ["文字", "人物"],
        alt: "两块错位材质表现时间与空间的张力",
      }) } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ data: [{ url: "https://images.example/cover.webp" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  await assert.rejects(
    syncObsidianNotes({ category: "journal", repoRoot: repo, vaultRoot: vault, requireCovers: true }),
    /Cover previews are missing/,
  );
  assert.equal(existsSync(path.join(repo, "src", "content", "notes", "封面测试.md")), false);

  const metadata = await generateCoverPreview({
    input: candidate.input,
    repoRoot: repo,
    config,
    fetchImpl: mockFetch,
    now: "2026-07-15T00:00:00.000Z",
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].authorization, "Bearer text-secret");
  assert.equal(calls[0].body.model, "gpt-5.5");
  assert.equal(calls[1].authorization, "Bearer image-secret");
  assert.equal(calls[1].body.model, "gpt-image-2");
  assert.doesNotMatch(JSON.stringify(metadata), /text-secret|image-secret/);

  await assert.rejects(
    syncObsidianNotes({ category: "journal", repoRoot: repo, vaultRoot: vault, requireCovers: true }),
    /await review/,
  );
  assert.equal(existsSync(path.join(repo, "src", "content", "notes", "封面测试.md")), false);

  const accepted = await syncObsidianNotes({
    category: "journal",
    repoRoot: repo,
    vaultRoot: vault,
    acceptCovers: true,
    requireCovers: true,
  });
  assert.deepEqual(accepted.covers.accepted, ["封面测试"]);
  const outputPath = path.join(repo, "src", "content", "notes", "封面测试.md");
  const output = await readFile(outputPath, "utf8");
  assert.match(output, /cover: \/assets\/notes\/封面测试\/cover.webp/);
  assert.match(output, /coverAlt: 两块错位材质表现时间与空间的张力/);
  assert.equal(existsSync(path.join(repo, "public", "assets", "notes", "封面测试", "cover.webp")), true);

  await writeFile(
    path.join(vault, "50-其他", "杂谈", "封面测试.md"),
    "---\npublish: true\ntags: [观察]\n---\n\n# 封面测试\n\n正文更新，但保留已经审核的封面。\n",
  );
  await syncObsidianNotes({ category: "journal", repoRoot: repo, vaultRoot: vault, requireCovers: true });
  assert.equal(existsSync(path.join(repo, "public", "assets", "notes", "封面测试", "cover.webp")), true);
});
