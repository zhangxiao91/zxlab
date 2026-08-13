import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
  AnnotationReplyDraft,
  GeneratedBriefingDraft,
  MemoryCandidateDraft,
} from "@zxlab/signal-schema";
import { handleSignalFetch } from "../src/index";
import type {
  AnnotationReplyInput,
  EditorialFilterInput,
  GenerateBriefingInput,
  MemoryExtractionInput,
  SignalLLM,
} from "../src/services/llm";

class AnnotationFixtureLLM implements SignalLLM {
  async filterCandidates(_input: EditorialFilterInput): Promise<never> {
    throw new Error("Not used by the authenticated send contract");
  }

  async generateBriefing(_input: GenerateBriefingInput): Promise<GeneratedBriefingDraft> {
    throw new Error("Not used by the authenticated send contract");
  }

  async replyToAnnotation(
    _input: AnnotationReplyInput,
    options: { onDelta?: (text: string) => void } = {},
  ): Promise<AnnotationReplyDraft> {
    options.onDelta?.("已完成入口合同验证。");
    return { reply: "已完成入口合同验证。" };
  }

  async extractMemory(_input: MemoryExtractionInput): Promise<MemoryCandidateDraft | null> {
    return null;
  }
}

async function seedBriefing(): Promise<{ briefingId: string; itemId: string }> {
  const runId = crypto.randomUUID();
  const briefingId = crypto.randomUUID();
  const itemId = crypto.randomUUID();
  const now = "2026-08-13T10:30:00.000Z";
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO briefing_runs
      (id, briefing_date, status, trigger_type, prompt_version, model, started_at, completed_at, candidate_count, selected_count)
      VALUES (?, '2026-08-13', 'succeeded', 'test', 'authenticated-send-contract', 'fixture', ?, ?, 1, 1)`)
      .bind(runId, now, now),
    env.DB.prepare(`INSERT INTO briefings
      (id, run_id, briefing_date, title, summary, status, is_active, data_origin, generated_at, prompt_version, model, long_term_threads_json)
      VALUES (?, ?, '2026-08-13', 'Contract briefing', 'Contract summary', 'ready', 0, 'fixture', ?, 'authenticated-send-contract', 'fixture', '[]')`)
      .bind(briefingId, runId, now),
    env.DB.prepare(`INSERT INTO briefing_items
      (id, briefing_id, category, title, summary, why_it_matters, importance, confidence, sort_order,
       item_type, lede, nut_graf, key_facts_json, implications)
      VALUES (?, ?, 'zxlab', 'Authenticated send', 'Contract summary', 'The private write must reach Signal.', 90, 90, 0,
       'lead', 'Contract lede', 'Contract nut graf', '["One known fact"]', 'The complete path stays testable.')`)
      .bind(itemId, briefingId),
  ]);
  return { briefingId, itemId };
}

function events(response: Response): Promise<Array<Record<string, unknown>>> {
  return response.text().then((raw) => raw.trim().split(/\n\n+/).map((chunk) => {
    const data = chunk.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
    if (!data) throw new Error("Missing SSE data line");
    return JSON.parse(data) as Record<string, unknown>;
  }));
}

describe("authenticated Signal send contract", () => {
  it("accepts the Runtime bearer, actionType body and terminal SSE response at the Worker entrypoint", async () => {
    const seeded = await seedBriefing();
    const response = await handleSignalFetch(new Request(
      "https://signal.example/api/annotations?stream=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer runtime-service-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          briefingId: seeded.briefingId,
          briefingItemId: seeded.itemId,
          selectedText: "一段需要复核的原文",
          comment: "请验证这条判断。",
          actionType: "challenge",
        }),
      },
    ), env, { annotations: { llm: new AnnotationFixtureLLM() } });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const streamed = await events(response);
    expect(streamed.map((event) => event.type)).toEqual([
      "start", "reply_delta", "reply", "memory", "done",
    ]);
    const done = streamed.at(-1)?.response as {
      annotation?: { action?: string };
      reply?: { content?: string };
    };
    expect(done.annotation?.action).toBe("challenge");
    expect(done.reply?.content).toBe("已完成入口合同验证。");
    const stored = await env.DB.prepare("SELECT action_type FROM annotations WHERE briefing_id = ?")
      .bind(seeded.briefingId)
      .first<{ action_type: string }>();
    expect(stored?.action_type).toBe("challenge");
  });
});
