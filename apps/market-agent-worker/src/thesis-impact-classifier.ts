import type { DossierFactDelta } from "@zxlab/market-agent-schema";
import { THESIS_IMPACT_GATEWAY_TASK } from "./gateway-policy.ts";

const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface ThesisImpactClassifierInput {
  profileId: string;
  instrumentId: string;
  theses: Array<{ id: string; text: string; status: "active" | "invalidated" | "retired" }>;
  factDeltas: DossierFactDelta[];
}

export interface ThesisImpactClassifierControls {
  signal?: AbortSignal;
  deadlineAt?: number;
}

export interface GatewayThesisImpactClassifierOptions {
  apiUrl: string;
  token: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export class GatewayThesisImpactClassifier {
  private readonly options: GatewayThesisImpactClassifierOptions;

  constructor(options: GatewayThesisImpactClassifierOptions) {
    this.options = options;
  }

  async classify(input: ThesisImpactClassifierInput, controls: ThesisImpactClassifierControls): Promise<unknown> {
    if (!this.options.apiUrl || !this.options.token) throw new Error("THESIS_IMPACT_CLASSIFIER_NOT_CONFIGURED");
    const response = await (this.options.fetcher ?? fetch)(this.options.apiUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "content-type": "application/json",
        accept: "application/json",
        "x-request-id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        task: THESIS_IMPACT_GATEWAY_TASK,
        context: {
          source: "market-agent-worker",
          operation: "thesis-impact",
          metadata: { schemaVersion: "thesis-impact-classifier.v1" },
        },
        messages: [
          {
            role: "system",
            content: "Return JSON only with exactly schemaVersion and impacts. schemaVersion must be thesis-impact-classifier.v1. Each impact may contain only thesisId, impact, explanation, factDeltaIds and evidenceIds. impact is supports, weakens, invalidates, mixed or insufficient_evidence. Cite only supplied IDs. Do not rewrite a thesis, add facts, include numbers, thresholds, trading instructions, arguments, provider data, formulas, URLs, cutoffs or private reasoning.",
          },
          {
            role: "user",
            content: JSON.stringify({
              instrumentId: input.instrumentId,
              theses: input.theses.filter((thesis) => thesis.status === "active").slice(0, 20).map(({ id, text }) => ({ id, text })),
              factDeltas: input.factDeltas.slice(0, 50).map(dossierDeltaSummary),
            }),
          },
        ],
        temperature: 0,
        maxOutputTokens: 1_200,
        responseFormat: { type: "json" },
      }),
      signal: combinedSignal(controls, this.options),
    });
    const payload = await readBoundedJson(response);
    if (!response.ok) throw new Error(`THESIS_IMPACT_HTTP_${response.status}`);
    const root = record(payload);
    const data = record(root?.data);
    if (!data || !("json" in data)) throw new Error("THESIS_IMPACT_INVALID_GATEWAY_RESPONSE");
    return data.json;
  }
}

function dossierDeltaSummary(delta: DossierFactDelta): Record<string, unknown> {
  return {
    id: delta.id,
    kind: delta.kind,
    evidenceId: delta.current.evidenceId,
    metric: delta.current.metric,
    period: delta.current.period,
    value: delta.current.value,
    comparisons: delta.current.comparisons.map(({ kind, comparablePeriod, decimal, unit }) => ({ kind, comparablePeriod, decimal, unit })),
    quality: { status: delta.current.quality.status, reliable: delta.current.quality.reliable },
  };
}

function combinedSignal(controls: ThesisImpactClassifierControls, options: GatewayThesisImpactClassifierOptions): AbortSignal {
  const now = options.now ?? Date.now;
  const configured = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const remaining = controls.deadlineAt === undefined ? configured : Math.max(1, Math.min(configured, controls.deadlineAt - now()));
  const timeout = AbortSignal.timeout(remaining);
  return controls.signal ? AbortSignal.any([controls.signal, timeout]) : timeout;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("THESIS_IMPACT_RESPONSE_TOO_LARGE");
  if (!response.body) throw new Error("THESIS_IMPACT_INVALID_JSON");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("THESIS_IMPACT_RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; }
  catch { throw new Error("THESIS_IMPACT_INVALID_JSON"); }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
