import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AnnotationReplyDraft,
  GeneratedBriefingDraft,
  MemoryCandidateDraft,
  WatchResponse,
  WatchesResponse,
} from "@zxlab/signal-schema";
import signalWorker from "../src/index";
import { BriefingRepository } from "../src/repositories/briefing-repository";
import { handleWatches } from "../src/routes/watches";
import { AnnotationResponder } from "../src/services/annotation-responder";
import type {
  AnnotationReplyInput,
  EditorialFilterInput,
  GenerateBriefingInput,
  MemoryExtractionInput,
  SignalLLM,
} from "../src/services/llm";
import { WatchModule } from "../src/watch/watch-module";

interface SeedBriefingInput {
  title: string;
  category?: "ai-engineering" | "markets" | "zxlab";
  summary?: string;
  generatedAt?: string;
  dataOrigin?: "fixture" | "real";
}

async function seedBriefing(input: SeedBriefingInput): Promise<{ briefingId: string; itemId: string }> {
  const runId = crypto.randomUUID();
  const briefingId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const date = generatedAt.slice(0, 10);
  const summary = input.summary ?? `Summary for ${input.title}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO briefing_runs
      (id, briefing_date, status, trigger_type, prompt_version, model, started_at, completed_at, candidate_count, selected_count)
      VALUES (?, ?, 'succeeded', 'test', 'watch-v1-test', 'fixture', ?, ?, 1, 1)`)
      .bind(runId, date, generatedAt, generatedAt),
    env.DB.prepare(`INSERT INTO briefings
      (id, run_id, briefing_date, title, summary, status, is_active, data_origin, generated_at, prompt_version, model, long_term_threads_json)
      VALUES (?, ?, ?, ?, ?, 'ready', 0, ?, ?, 'watch-v1-test', 'fixture', '[]')`)
      .bind(briefingId, runId, date, `Briefing: ${input.title}`, summary, input.dataOrigin ?? "real", generatedAt),
    env.DB.prepare(`INSERT INTO briefing_items
      (id, briefing_id, category, title, summary, why_it_matters, importance, confidence, sort_order,
       item_type, lede, nut_graf, key_facts_json, implications)
      VALUES (?, ?, ?, ?, ?, ?, 80, 90, 0, 'lead', ?, ?, ?, ?)`)
      .bind(itemId, briefingId, input.category ?? "ai-engineering", input.title, summary,
        "This update matters to the watched story.", summary, summary, JSON.stringify([summary]), "Review the confirmed development."),
    env.DB.prepare(`INSERT INTO briefing_sources (id, item_id, title, url, publisher, published_at)
      VALUES (?, ?, ?, ?, 'Test Publisher', ?)`)
      .bind(crypto.randomUUID(), itemId, input.title, `https://example.com/${itemId}`, generatedAt),
  ]);
  return { briefingId, itemId };
}

async function addBriefingItems(briefingId: string, titles: string[]): Promise<string[]> {
  const itemIds = titles.map(() => crypto.randomUUID());
  await env.DB.batch(titles.flatMap((title, index) => {
    const itemId = itemIds[index]!;
    const summary = `Summary for ${title}`;
    return [
      env.DB.prepare(`INSERT INTO briefing_items
        (id, briefing_id, category, title, summary, why_it_matters, importance, confidence, sort_order,
         item_type, lede, nut_graf, key_facts_json, implications)
        VALUES (?, ?, 'ai-engineering', ?, ?, ?, 70, 85, ?, 'brief', ?, ?, ?, ?)`)
        .bind(itemId, briefingId, title, summary, "This update matters to the watched story.", index + 1,
          summary, summary, JSON.stringify([summary]), "Review the confirmed development."),
      env.DB.prepare(`INSERT INTO briefing_sources (id, item_id, title, url, publisher, published_at)
        VALUES (?, ?, ?, ?, 'Test Publisher', '2030-08-09T08:00:00.000Z')`)
        .bind(crypto.randomUUID(), itemId, title, `https://example.com/${itemId}`),
    ];
  }));
  return itemIds;
}

function databaseWithBatchHook(hook: (statements: D1PreparedStatement[]) => Promise<void>): D1Database {
  return {
    prepare(query: string) { return env.DB.prepare(query); },
    async batch(statements: D1PreparedStatement[]) {
      await hook(statements);
      return env.DB.batch(statements);
    },
  } as unknown as D1Database;
}

class TrackReplyLLM implements SignalLLM {
  extractCalls = 0;

  async filterCandidates(_input: EditorialFilterInput): Promise<never> {
    throw new Error("Not used by this test");
  }

  async generateBriefing(_input: GenerateBriefingInput): Promise<GeneratedBriefingDraft> {
    throw new Error("Not used by this test");
  }

  async replyToAnnotation(_input: AnnotationReplyInput): Promise<AnnotationReplyDraft> {
    return { reply: "已记录追踪意图；Watch 需要通过独立的显式操作创建。" };
  }

  async extractMemory(_input: MemoryExtractionInput): Promise<MemoryCandidateDraft | null> {
    this.extractCalls += 1;
    return {
      shouldRemember: true,
      scope: "project",
      content: "This must not become Memory.",
      confidence: 1,
      reason: "Regression sentinel",
    };
  }
}

describe("Signal Watch v1", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM watch_observations"),
      env.DB.prepare("DELETE FROM watch_dossiers"),
    ]);
  });

  it("creates an active Watch only from a real briefing item and returns the wrapped list shape", async () => {
    const seed = await seedBriefing({ title: "OpenAI signs Oracle cloud infrastructure agreement" });
    const response = await handleWatches(new Request("https://signal.example/api/watches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        briefingId: seed.briefingId,
        briefingItemId: seed.itemId,
        condition: "Track confirmed capacity, financing, or delivery changes.",
        title: "Client supplied title must be ignored",
        category: "markets",
      }),
    }), "/api/watches", env);
    expect(response?.status).toBe(201);
    const created = await response!.json<WatchResponse>();
    expect(created.watch).toMatchObject({
      title: "OpenAI signs Oracle cloud infrastructure agreement",
      category: "ai-engineering",
      status: "active",
      seedBriefingId: seed.briefingId,
      seedBriefingItemId: seed.itemId,
    });
    expect(created.watch.observations).toHaveLength(1);
    expect(created.watch.observations[0]).toMatchObject({
      type: "created",
      briefingId: seed.briefingId,
      briefingItemId: seed.itemId,
    });
    expect(created.watch.observations[0]?.sources[0]?.publisher).toBe("Test Publisher");

    const retryResponse = await handleWatches(new Request("https://signal.example/api/watches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        briefingId: seed.briefingId,
        briefingItemId: seed.itemId,
        condition: "  Track confirmed capacity, financing, or delivery changes.  ",
      }),
    }), "/api/watches", env);
    const retried = await retryResponse!.json<WatchResponse>();
    expect(retried.watch.id).toBe(created.watch.id);
    expect(retried.watch.observations).toHaveLength(1);

    const listedResponse = await handleWatches(
      new Request("https://signal.example/api/watches"),
      "/api/watches",
      env,
    );
    const listed = await listedResponse!.json<WatchesResponse>();
    expect(listed.watches.map((watch) => watch.id)).toEqual([created.watch.id]);

    await expect(handleWatches(new Request("https://signal.example/api/watches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ briefingId: seed.briefingId, briefingItemId: crypto.randomUUID(), condition: "Track it." }),
    }), "/api/watches", env)).rejects.toMatchObject({ code: "ITEM_NOT_FOUND" });
  });

  it("rejects fixture briefing items without persisting a Watch", async () => {
    const seed = await seedBriefing({
      title: "Fixture-only Watch seed",
      dataOrigin: "fixture",
    });
    const module = new WatchModule(env.DB);

    await expect(module.create({
      briefingId: seed.briefingId,
      briefingItemId: seed.itemId,
      condition: "This fixture must never become persistent evidence.",
    })).rejects.toMatchObject({ code: "ITEM_NOT_FOUND", status: 404 });
    await expect(module.list()).resolves.toEqual([]);
  });

  it("matches a later briefing deterministically and inserts the update only once", async () => {
    const module = new WatchModule(env.DB);
    const seed = await seedBriefing({
      title: "OpenAI signs Oracle cloud infrastructure agreement",
      generatedAt: "2030-08-08T08:00:00.000Z",
    });
    const watch = await module.create({
      briefingId: seed.briefingId,
      briefingItemId: seed.itemId,
      condition: "Track confirmed cloud capacity and delivery changes.",
    });
    const next = await seedBriefing({
      title: "Oracle and OpenAI expand cloud infrastructure agreement",
      summary: "The partners confirmed additional cloud capacity and a revised delivery schedule.",
      generatedAt: "2030-08-09T08:00:00.000Z",
      dataOrigin: "real",
    });
    const briefing = await new BriefingRepository(env.DB).getById(next.briefingId);

    await expect(module.observeBriefing(briefing)).resolves.toBe(1);
    await expect(module.observeBriefing(briefing)).resolves.toBe(0);

    const updated = (await module.list()).find((entry) => entry.id === watch.id)!;
    expect(updated.observations).toHaveLength(2);
    expect(updated.observations[1]).toMatchObject({
      type: "update",
      briefingId: next.briefingId,
      briefingItemId: next.itemId,
      observedAt: "2030-08-09T08:00:00.000Z",
    });
    const count = await env.DB.prepare("SELECT COUNT(*) count FROM watch_observations WHERE watch_id = ? AND briefing_item_id = ?")
      .bind(watch.id, next.itemId).first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("reactivates an explicitly recreated resolved Watch without losing observation history", async () => {
    const module = new WatchModule(env.DB);
    const seed = await seedBriefing({ title: "OpenAI signs Oracle cloud infrastructure agreement" });
    const input = {
      briefingId: seed.briefingId,
      briefingItemId: seed.itemId,
      condition: "Track confirmed capacity changes.",
    };
    const created = await module.create(input);
    const resolved = await module.resolve(created.id);
    expect(resolved.status).toBe("resolved");

    const reactivated = await module.create(input);

    expect(reactivated.id).toBe(created.id);
    expect(reactivated.status).toBe("active");
    expect(reactivated.resolvedAt).toBeUndefined();
    expect(reactivated.observations).toEqual(created.observations);
  });

  it("observes only strictly later briefing dates, not same-day reruns or backfills", async () => {
    const module = new WatchModule(env.DB);
    const seed = await seedBriefing({
      title: "OpenAI signs Oracle cloud infrastructure agreement",
      generatedAt: "2030-08-08T08:00:00.000Z",
    });
    const watch = await module.create({
      briefingId: seed.briefingId,
      briefingItemId: seed.itemId,
      condition: "Track confirmed cloud capacity changes.",
    });
    const sameDay = await seedBriefing({
      title: "Oracle and OpenAI expand cloud infrastructure agreement",
      generatedAt: "2030-08-08T20:00:00.000Z",
      dataOrigin: "real",
    });
    const later = await seedBriefing({
      title: "Oracle and OpenAI expand cloud infrastructure agreement again",
      generatedAt: "2030-08-09T08:00:00.000Z",
      dataOrigin: "real",
    });
    const sameLaterDay = await seedBriefing({
      title: "OpenAI and Oracle revise cloud infrastructure agreement",
      generatedAt: "2030-08-09T20:00:00.000Z",
      dataOrigin: "real",
    });
    const backfill = await seedBriefing({
      title: "OpenAI and Oracle announce cloud infrastructure agreement",
      generatedAt: "2030-08-07T08:00:00.000Z",
      dataOrigin: "real",
    });

    await expect(module.observeBriefing(await new BriefingRepository(env.DB).getById(sameDay.briefingId))).resolves.toBe(0);
    await expect(module.observeBriefing(await new BriefingRepository(env.DB).getById(later.briefingId))).resolves.toBe(1);
    await expect(module.observeBriefing(await new BriefingRepository(env.DB).getById(sameLaterDay.briefingId))).resolves.toBe(0);
    await expect(module.observeBriefing(await new BriefingRepository(env.DB).getById(backfill.briefingId))).resolves.toBe(0);

    const updated = (await module.list()).find((entry) => entry.id === watch.id)!;
    expect(updated.observations.map((entry) => entry.briefingId)).toEqual([seed.briefingId, later.briefingId]);
  });

  it("keeps the newest briefing when an older observation loses the persistence race", async () => {
    const module = new WatchModule(env.DB);
    const seed = await seedBriefing({
      title: "Anthropic expands Claude enterprise agreement with major banks",
      generatedAt: "2030-08-08T08:00:00.000Z",
    });
    const watch = await module.create({
      briefingId: seed.briefingId,
      briefingItemId: seed.itemId,
      condition: "Track confirmed bank deployments.",
    });
    const older = await seedBriefing({
      title: "Major banks expand Anthropic Claude enterprise agreement",
      generatedAt: "2030-08-09T08:00:00.000Z",
      dataOrigin: "real",
    });
    const newer = await seedBriefing({
      title: "Anthropic and major banks broaden Claude enterprise agreement",
      generatedAt: "2030-08-10T08:00:00.000Z",
      dataOrigin: "real",
    });
    const [olderBriefing, newerBriefing] = await Promise.all([
      new BriefingRepository(env.DB).getById(older.briefingId),
      new BriefingRepository(env.DB).getById(newer.briefingId),
    ]);
    let intercepted = false;
    const racingModule = new WatchModule(databaseWithBatchHook(async () => {
      if (intercepted) return;
      intercepted = true;
      await expect(module.observeBriefing(newerBriefing)).resolves.toBe(1);
    }));

    await expect(racingModule.observeBriefing(olderBriefing)).resolves.toBe(0);

    const updated = (await module.list()).find((entry) => entry.id === watch.id)!;
    expect(updated.updatedAt).toBe(newerBriefing.generatedAt);
    expect(updated.observations.map((entry) => entry.briefingId)).toEqual([seed.briefingId, newer.briefingId]);
  });

  it("repairs updatedAt on an idempotent observation retry", async () => {
    const module = new WatchModule(env.DB);
    const seed = await seedBriefing({ title: "OpenAI signs Oracle cloud infrastructure agreement" });
    const watch = await module.create({
      briefingId: seed.briefingId,
      briefingItemId: seed.itemId,
      condition: "Track confirmed capacity changes.",
    });
    const next = await seedBriefing({
      title: "Oracle and OpenAI expand cloud infrastructure agreement",
      generatedAt: "2030-08-09T08:00:00.000Z",
      dataOrigin: "real",
    });
    const briefing = await new BriefingRepository(env.DB).getById(next.briefingId);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO watch_observations
        (id, watch_id, observation_type, briefing_id, briefing_item_id, title, summary, sources_json, observed_at)
        VALUES (?, ?, 'update', ?, ?, ?, ?, '[]', ?)`)
        .bind(crypto.randomUUID(), watch.id, next.briefingId, next.itemId,
          briefing.items[0]!.title, briefing.items[0]!.summary, briefing.generatedAt),
      env.DB.prepare("UPDATE watch_dossiers SET updated_at = '2026-08-01T00:00:00.000Z' WHERE id = ?").bind(watch.id),
    ]);

    await expect(module.observeBriefing(briefing)).resolves.toBe(0);
    expect((await module.list()).find((entry) => entry.id === watch.id)?.updatedAt).toBe(briefing.generatedAt);
  });

  it("does not insert after resolve wins the race with observation persistence", async () => {
    const module = new WatchModule(env.DB);
    const seed = await seedBriefing({ title: "Anthropic expands Claude enterprise agreement with major banks" });
    const watch = await module.create({
      briefingId: seed.briefingId,
      briefingItemId: seed.itemId,
      condition: "Track confirmed bank deployments.",
    });
    const later = await seedBriefing({
      title: "Major banks expand Anthropic Claude enterprise agreement",
      generatedAt: "2030-08-09T08:00:00.000Z",
      dataOrigin: "real",
    });
    const briefing = await new BriefingRepository(env.DB).getById(later.briefingId);
    let intercepted = false;
    const racingModule = new WatchModule(databaseWithBatchHook(async () => {
      if (intercepted) return;
      intercepted = true;
      await module.resolve(watch.id);
    }));

    await expect(racingModule.observeBriefing(briefing)).resolves.toBe(0);
    const resolved = (await module.list()).find((entry) => entry.id === watch.id)!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.observations).toHaveLength(1);
  });

  it("bounds one briefing to 100 active Watches, one match each, and four write batches", async () => {
    const seed = await seedBriefing({ title: "OpenAI signs Oracle cloud infrastructure agreement" });
    const now = "2026-08-01T00:00:00.000Z";
    await env.DB.batch(Array.from({ length: 100 }, (_, index) => env.DB.prepare(`INSERT INTO watch_dossiers
      (id, title, condition, category, status, seed_briefing_id, seed_briefing_item_id, created_at, updated_at)
      VALUES (?, ?, ?, 'ai-engineering', 'active', ?, ?, ?, ?)`)
      .bind(`bounded-watch-${String(index).padStart(3, "0")}`, "OpenAI signs Oracle cloud infrastructure agreement",
        `Bounded condition ${index}.`, seed.briefingId, seed.itemId, now, now)));
    const next = await seedBriefing({
      title: "OpenAI signs Oracle cloud infrastructure agreement update",
      generatedAt: "2030-08-09T08:00:00.000Z",
      dataOrigin: "real",
    });
    await addBriefingItems(next.briefingId, Array.from({ length: 11 }, (_, index) =>
      `Oracle and OpenAI expand cloud infrastructure agreement update ${index + 1}`));
    const briefing = await new BriefingRepository(env.DB).getById(next.briefingId);
    let batchCalls = 0;
    let maxStatements = 0;
    const bounded = new WatchModule(databaseWithBatchHook(async (statements) => {
      batchCalls += 1;
      maxStatements = Math.max(maxStatements, statements.length);
    }));

    await expect(bounded.observeBriefing(briefing)).resolves.toBe(100);
    expect(batchCalls).toBe(4);
    expect(maxStatements).toBe(50);
    const observed = await env.DB.prepare("SELECT COUNT(*) count FROM watch_observations WHERE observation_type = 'update'")
      .first<{ count: number }>();
    expect(observed?.count).toBe(100);
    const duplicates = await env.DB.prepare(`SELECT COUNT(*) count FROM (
      SELECT watch_id FROM watch_observations WHERE observation_type = 'update' GROUP BY watch_id HAVING COUNT(*) > 1
    )`).first<{ count: number }>();
    expect(duplicates?.count).toBe(0);

    const module = new WatchModule(env.DB);
    await expect(module.create({
      briefingId: seed.briefingId,
      briefingItemId: seed.itemId,
      condition: "One Watch beyond the active limit.",
    })).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
    await expect(module.create({
      briefingId: seed.briefingId,
      briefingItemId: seed.itemId,
      condition: "Bounded condition 0.",
    })).resolves.toMatchObject({ id: "bounded-watch-000" });

    await module.resolve("bounded-watch-000");
    await expect(module.create({
      briefingId: seed.briefingId,
      briefingItemId: seed.itemId,
      condition: "Replacement Watch at capacity.",
    })).resolves.toMatchObject({ status: "active" });
    await expect(module.create({
      briefingId: seed.briefingId,
      briefingItemId: seed.itemId,
      condition: "Bounded condition 0.",
    })).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
  });

  it("resolves a Watch and stops observing related later briefings", async () => {
    const module = new WatchModule(env.DB);
    const seed = await seedBriefing({ title: "Anthropic expands Claude enterprise agreement with major banks" });
    const watch = await module.create({
      briefingId: seed.briefingId,
      briefingItemId: seed.itemId,
      condition: "Track confirmed bank deployments.",
    });
    const resolved = await module.resolve(watch.id);
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).toBeDefined();

    const later = await seedBriefing({ title: "Major banks expand Anthropic Claude enterprise agreement" });
    const briefing = await new BriefingRepository(env.DB).getById(later.briefingId);
    await expect(module.observeBriefing(briefing)).resolves.toBe(0);
    expect((await module.list())[0]?.observations).toHaveLength(1);
  });

  it("does not write observations for fixture briefings", async () => {
    const module = new WatchModule(env.DB);
    const seed = await seedBriefing({ title: "OpenAI signs Oracle cloud infrastructure agreement" });
    const watch = await module.create({
      briefingId: seed.briefingId,
      briefingItemId: seed.itemId,
      condition: "Track confirmed capacity changes.",
    });
    const fixture = await seedBriefing({ title: "Oracle and OpenAI expand cloud infrastructure agreement" });
    const briefing = await new BriefingRepository(env.DB).getById(fixture.briefingId);

    await expect(module.observeBriefing(briefing)).resolves.toBe(0);
    expect((await module.list()).find((entry) => entry.id === watch.id)?.observations).toHaveLength(1);
  });

  it("protects Watch routes at the Worker seam", async () => {
    const getResponse = await signalWorker.fetch(new Request("https://signal.example/api/watches"), env);
    const postResponse = await signalWorker.fetch(new Request("https://signal.example/api/watches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ briefingId: "briefing", briefingItemId: "item", condition: "Track it." }),
    }), env);
    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
  });

  it("keeps track annotations out of the Memory extraction path", async () => {
    const seed = await seedBriefing({ title: "Cloudflare Workers runtime capability changes" });
    const llm = new TrackReplyLLM();
    const response = await new AnnotationResponder(env, llm).respond({
      briefingId: seed.briefingId,
      briefingItemId: seed.itemId,
      selectedText: "runtime capability changes",
      comment: "继续追踪后续兼容性变化",
      action: "track",
    });

    expect(llm.extractCalls).toBe(0);
    expect(response.memoryCandidate).toBeUndefined();
    expect(await new WatchModule(env.DB).list()).toEqual([]);
    const candidateCount = await env.DB.prepare(`SELECT COUNT(*) count FROM memory_consolidation_candidates
      WHERE source_event_ids_json = ?`).bind(JSON.stringify([response.annotation.id])).first<{ count: number }>();
    expect(candidateCount?.count).toBe(0);
  });
});
