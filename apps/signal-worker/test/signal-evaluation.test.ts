import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAdmin } from "../src/routes/admin";
import goldEditions from "../fixtures/gold-editions.json";
import { BRIEFING_PROMPT_VERSION } from "../src/services/prompts";
import { SIGNAL_SOURCE_POLICY_VERSION } from "../src/services/source-policy";
import { assertEditionQuality } from "../src/services/edition-quality";
import { buildStoryDossiers } from "../src/services/story-context";
import type { CandidateSignal, GeneratedBriefingDraft } from "@zxlab/signal-schema";

const now = "2026-08-21T23:40:00.000Z";

describe("Signal Evaluation", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM briefing_evaluations").run();
  });

  it("upserts a text-free edition assessment and returns honest availability", async () => {
    await env.DB.prepare(`INSERT INTO briefing_runs
      (id, briefing_date, status, trigger_type, prompt_version, model, started_at, completed_at,
       candidate_count, selected_count, fetched_count, unique_count, balanced_count, synthesis_count)
      VALUES (?, ?, 'succeeded', 'workflow', ?, ?, ?, ?, 12, 10, 30, 20, 12, 10)`)
      .bind("evaluation-run", "2026-08-22", "signal-briefing-v1", "test-model", now, now).run();
    await env.DB.prepare(`INSERT INTO briefings
      (id, run_id, briefing_date, title, summary, status, is_active, data_origin, generated_at,
       prompt_version, model, supersedes_id, generation_mode, quality_status)
      VALUES (?, ?, ?, ?, ?, 'ready', 1, 'real', ?, ?, ?, NULL, 'model', 'passed')`)
      .bind("evaluation-briefing", "evaluation-run", "2026-08-22", "private title sentinel", "private summary sentinel", now,
        "signal-briefing-v1", "test-model").run();

    const request = (ratings: Record<string, number>) => new Request(
      "https://signal.example/api/admin/evaluation/editions/evaluation-briefing",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ratings }) },
    );
    expect((await handleAdmin(request({ informationGain: 1, personalRelevance: 2 }),
      "/api/admin/evaluation/editions/evaluation-briefing", env))?.status).toBe(200);
    expect((await handleAdmin(request({ informationGain: 2, threeDayValue: 1 }),
      "/api/admin/evaluation/editions/evaluation-briefing", env))?.status).toBe(200);

    const response = await handleAdmin(
      new Request("https://signal.example/api/admin/evaluation/summary?from=2026-08-22&to=2026-08-22"),
      "/api/admin/evaluation/summary",
      env,
    );
    const body = await response?.json() as { editions: Array<Record<string, unknown>> };
    expect(body.editions).toEqual([expect.objectContaining({
      briefingId: "evaluation-briefing",
      date: "2026-08-22",
      generationMode: "model",
      qualityStatus: "passed",
      counts: { fetched: 30, unique: 20, balanced: 12, synthesized: 10, published: 10 },
      sourceMetrics: { availability: false, families: {} },
      behaviorMetrics: { availability: false, actions: {}, annotations: 0, watches: 0, memoryCandidates: {} },
      assessment: expect.objectContaining({ ratings: { informationGain: 2, threeDayValue: 1 } }),
    })]);
    expect(JSON.stringify(body)).not.toContain("private title sentinel");
    expect(JSON.stringify(body)).not.toContain("private summary sentinel");
    expect(JSON.stringify(body)).not.toContain("errorMessage");
  });

  it("rejects ratings outside the fixed zero-to-two rubric", async () => {
    const responsePromise = handleAdmin(new Request(
      "https://signal.example/api/admin/evaluation/editions/missing",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ratings: { freshness: 3 } }) },
    ), "/api/admin/evaluation/editions/missing", env);
    await expect(responsePromise).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
  });

  it("regresses fixed gold-edition policy, prompt, model and quality metadata without storing text", async () => {
    const gold = goldEditions[0]!;
    expect(SIGNAL_SOURCE_POLICY_VERSION).toBe(gold.sourcePolicyVersion);
    expect(BRIEFING_PROMPT_VERSION).toBe(gold.promptVersion);
    expect(env.ZX_SIGNAL_LLM_LABEL).toBe(gold.model);
    const candidates: CandidateSignal[] = gold.qualityGate.candidateIds.map((id) => ({
      id,
      source: { sourceId: "mit-technology-review", sourceName: "Independent report", sourceType: "rss", externalId: id },
      categoryHint: "ai-engineering",
      title: `Gold candidate ${id}`,
      url: `https://example.com/${id}`,
      canonicalUrl: `https://example.com/${id}`,
      summary: "Fixed test material for the final edition gate.",
      fetchedAt: now,
      tags: ["gold-fixture"],
      contentHash: `hash-${id}`,
      metadata: {},
      collectionRunId: `${gold.id}:collection`,
      status: "eligible",
    }));
    const draft: GeneratedBriefingDraft = {
      title: "Gold gate test",
      summary: "Fixed test material.",
      longTermThreads: [],
      items: [{
        itemType: "lead",
        category: "ai-engineering",
        title: "Independent report",
        lede: "A fixed lead.",
        nutGraf: "A fixed significance statement.",
        keyFacts: ["One fixed fact."],
        broaderContext: "Fixed context.",
        implications: "Fixed implications.",
        counterpoint: "Fixed counterpoint.",
        watchNext: "Fixed follow-up.",
        importance: 80,
        confidence: 80,
        sourceIds: gold.qualityGate.candidateIds,
      }],
    };
    if (gold.qualityGate.expected === "pass") {
      expect(assertEditionQuality({ draft, candidates, storyDossiers: buildStoryDossiers(candidates) })).toBe(draft);
    }
    await env.DB.prepare(`INSERT INTO briefing_runs
      (id, briefing_date, status, trigger_type, prompt_version, model, started_at, completed_at,
       candidate_count, selected_count, fetched_count, unique_count, balanced_count, synthesis_count, source_policy_version)
      VALUES (?, ?, 'succeeded', 'workflow', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(`${gold.id}:run`, gold.date, gold.promptVersion, gold.model, now, now,
        gold.counts.balanced, gold.counts.published, gold.counts.fetched, gold.counts.unique,
        gold.counts.balanced, gold.counts.synthesized, gold.sourcePolicyVersion).run();
    await env.DB.prepare(`INSERT INTO briefings
      (id, run_id, briefing_date, title, summary, status, is_active, data_origin, generated_at,
       prompt_version, model, supersedes_id, generation_mode, quality_status)
      VALUES (?, ?, ?, ?, ?, 'ready', 1, 'real', ?, ?, ?, NULL, ?, ?)`)
      .bind(gold.briefingId, `${gold.id}:run`, gold.date, "text-not-in-gold-fixture", "text-not-in-gold-fixture",
        now, gold.promptVersion, gold.model, gold.generationMode, gold.qualityStatus).run();

    const assessmentResponse = await handleAdmin(new Request(
      `https://signal.example/api/admin/evaluation/editions/${gold.briefingId}`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ratings: gold.ratings }) },
    ), `/api/admin/evaluation/editions/${gold.briefingId}`, env);
    expect(assessmentResponse?.status).toBe(200);
    const summaryResponse = await handleAdmin(new Request(
      `https://signal.example/api/admin/evaluation/summary?from=${gold.date}&to=${gold.date}`,
    ), "/api/admin/evaluation/summary", env);
    const body = await summaryResponse?.json() as { editions: Array<Record<string, unknown>> };

    expect(body.editions[0]).toMatchObject({
      briefingId: gold.briefingId,
      date: gold.date,
      sourcePolicyVersion: gold.sourcePolicyVersion,
      promptVersion: gold.promptVersion,
      model: gold.model,
      generationMode: gold.generationMode,
      qualityStatus: gold.qualityStatus,
      counts: gold.counts,
      assessment: { rubricVersion: "signal-edition-v1", ratings: gold.ratings },
    });
    expect(JSON.stringify(gold)).not.toContain("text-not-in-gold-fixture");
    const prohibitedKeys = new Set(["prompt", "response", "reply", "userText", "body"]);
    const keys = JSON.stringify(gold, (key, value) => {
      if (key) expect(prohibitedKeys.has(key)).toBe(false);
      return value;
    });
    expect(keys).not.toContain("text-not-in-gold-fixture");
  });
});
