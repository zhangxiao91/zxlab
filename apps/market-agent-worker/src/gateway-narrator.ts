import type { AgentNarration, MarketAgentCommand, SealedEvidenceBundle } from "@zxlab/market-agent-schema";
import { MARKET_AGENT_GATEWAY_TASK } from "./gateway-policy.ts";
import type { Narrator } from "./narration.ts";

export interface GatewayNarratorOptions { apiUrl: string; token: string; fetcher?: typeof fetch; timeoutMs?: number; }

export class GatewayNarrator implements Narrator {
  private readonly options: GatewayNarratorOptions;
  constructor(options: GatewayNarratorOptions) { this.options = options; }

  async narrate(input: { workflow: MarketAgentCommand["workflow"]; evidence: SealedEvidenceBundle }): Promise<unknown> {
    return this.request(input);
  }

  async repair(input: { workflow: MarketAgentCommand["workflow"]; evidence: SealedEvidenceBundle; issues: string[] }): Promise<unknown> {
    return this.request(input, input.issues);
  }

  private async request(input: { workflow: MarketAgentCommand["workflow"]; evidence: SealedEvidenceBundle }, repairIssues?: string[]): Promise<unknown> {
    if (!this.options.apiUrl || !this.options.token) throw new Error("MARKET_AGENT_GATEWAY_NOT_CONFIGURED");
    const body = { task: MARKET_AGENT_GATEWAY_TASK, context: { source: "market-agent-worker", operation: "close-review" }, messages: [
      { role: "system", content: "Return JSON only. Describe the sealed evidence without changing facts, events, rules, or memory. Cite only evidence IDs in the bundle. Never provide trading instructions." },
      { role: "user", content: JSON.stringify({ workflow: input.workflow, evidence: input.evidence, ...(repairIssues ? { repair: { validationIssues: repairIssues, instruction: "Correct only these validation failures and return the full JSON object." } } : {}) }) }
    ], temperature: 0, maxOutputTokens: 2400, responseFormat: { type: "json" } };
    const fetcher = this.options.fetcher ?? fetch;
    const streamUrl = this.options.apiUrl.replace(/\/generate\/?$/, "/stream");
    const response = await fetcher(streamUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json", accept: "text/event-stream", "x-request-id": crypto.randomUUID() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 90_000),
    });
    if (response.ok && response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) return parseGatewayNarration(await readTerminalEvent(response));
    if (![404, 405, 501].includes(response.status)) { const payload = await safeJson(response); if (!response.ok) throw new Error(`MARKET_AGENT_GATEWAY_HTTP_${response.status}`); return parseGatewayNarration(payload); }
    const fallback = await fetcher(this.options.apiUrl, { method: "POST", headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json", accept: "application/json", "x-request-id": crypto.randomUUID() }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.options.timeoutMs ?? 90_000) });
    const payload = await safeJson(fallback);
    if (!fallback.ok) throw new Error(`MARKET_AGENT_GATEWAY_HTTP_${fallback.status}`);
    return parseGatewayNarration(payload);
  }
}

async function readTerminalEvent(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > 512 * 1024) throw new Error("MARKET_AGENT_GATEWAY_RESPONSE_TOO_LARGE");
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    const event = JSON.parse(data) as Record<string, unknown>;
    if (event.type === "error") throw new Error("MARKET_AGENT_GATEWAY_STREAM_ERROR");
    if (event.type === "done") return { data: event.data };
  }
  throw new Error("MARKET_AGENT_GATEWAY_STREAM_INCOMPLETE");
}

async function safeJson(response: Response): Promise<unknown> { const raw = await response.text(); if (new TextEncoder().encode(raw).byteLength > 512 * 1024) throw new Error("MARKET_AGENT_GATEWAY_RESPONSE_TOO_LARGE"); try { return JSON.parse(raw) as unknown; } catch { throw new Error("MARKET_AGENT_GATEWAY_INVALID_JSON"); } }

function parseGatewayNarration(value: unknown): AgentNarration | unknown {
  const root = record(value); if (!root) return value;
  const data = record(root.data); if (!data) return value;
  if (data.json !== undefined) return data.json;
  if (typeof data.text !== "string") return value;
  const cleaned = data.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned) as unknown; } catch { return value; }
}
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
