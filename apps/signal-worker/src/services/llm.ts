import {
  annotationReplyJsonSchema,
  briefingDraftJsonSchema,
  editorialDecisionJsonSchema,
  memoryCandidateJsonSchema,
  parseAnnotationReplyDraft,
  parseGeneratedBriefingDraft,
  parseEditorialDecisionDraft,
  parseMemoryCandidateDraft,
  SignalValidationError,
  type AnnotationAction,
  type AnnotationReplyDraft,
  type BriefingItem,
  type CandidateEditorialDecision,
  type CandidateSignal,
  type GeneratedBriefingDraft,
  type MemoryCandidateDraft,
  type MemoryEntry,
} from "@zxlab/signal-schema";
import { SignalError } from "../lib/errors";
import { ModelInvocationRepository, type InvocationTask } from "../repositories/model-invocation-repository";
import {
  BRIEFING_PROMPT_VERSION,
  EDITORIAL_PROMPT_VERSION,
  MEMORY_PROMPT_VERSION,
  REPLY_PROMPT_VERSION,
  buildAnnotationReplyPrompt,
  buildBriefingPrompt,
  buildEditorialPrompt,
  buildMemoryPrompt,
} from "./prompts";

export interface GenerateBriefingInput { date: string; candidates: CandidateSignal[]; memories: MemoryEntry[]; runId: string; }
export interface EditorialFilterInput { candidates: CandidateSignal[]; memories: MemoryEntry[]; runId: string; }
export interface AnnotationReplyInput { item: BriefingItem; selectedText: string; comment: string; action: AnnotationAction; memories: MemoryEntry[]; }
export interface MemoryExtractionInput { item: BriefingItem; selectedText: string; comment: string; action: AnnotationAction; reply: string; }

export interface SignalLLM {
  filterCandidates(input: EditorialFilterInput): Promise<CandidateEditorialDecision[]>;
  generateBriefing(input: GenerateBriefingInput): Promise<GeneratedBriefingDraft>;
  replyToAnnotation(input: AnnotationReplyInput): Promise<AnnotationReplyDraft>;
  extractMemory(input: MemoryExtractionInput): Promise<MemoryCandidateDraft | null>;
}

interface JsonRunOptions<T> {
  task: InvocationTask;
  gatewayTask: "signal-editorial-filter" | "signal-briefing" | "signal-annotation-reply" | "signal-memory-extraction";
  promptVersion: string;
  prompt: { system: string; user: string };
  schema: object;
  validate: (value: unknown) => T;
  runId?: string;
  repair?: boolean;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

interface GatewaySuccess {
  ok: true;
  data: {
    text: string;
    json?: unknown;
    provider: string;
    model: string;
    fallbackIndex: number;
    latencyMs: number;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  };
  requestId: string;
}

function gatewaySuccess(value: unknown): GatewaySuccess {
  const root = object(value);
  const data = object(root?.data);
  if (root?.ok !== true || !data || typeof root.requestId !== "string"
    || typeof data.text !== "string" || typeof data.provider !== "string" || typeof data.model !== "string"
    || typeof data.fallbackIndex !== "number" || typeof data.latencyMs !== "number") {
    throw new SignalValidationError("Gateway response did not match the success contract");
  }
  return value as GatewaySuccess;
}

function responseValue(result: GatewaySuccess): unknown {
  if (result.data.json !== undefined) return result.data.json;
  const cleaned = result.data.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned) as unknown;
}

export class ProjectApiSignalLLM implements SignalLLM {
  private readonly invocations: ModelInvocationRepository;

  constructor(private readonly env: Env, private readonly fetcher: typeof fetch = fetch) {
    this.invocations = new ModelInvocationRepository(env.DB);
  }

  async filterCandidates(input: EditorialFilterInput): Promise<CandidateEditorialDecision[]> {
    const candidateIds = new Set(input.candidates.map((candidate) => candidate.id));
    const memoryIds = new Set(input.memories.map((memory) => memory.id));
    const result = await this.runJson({
      task: "editorial-filter",
      gatewayTask: "signal-editorial-filter",
      promptVersion: EDITORIAL_PROMPT_VERSION,
      prompt: buildEditorialPrompt(input),
      schema: editorialDecisionJsonSchema,
      validate: (value: unknown) => parseEditorialDecisionDraft(value, candidateIds, memoryIds),
      runId: input.runId,
    });
    if (result.decisions.length !== input.candidates.length) throw new SignalValidationError("Editorial filter must decide every candidate");
    return result.decisions;
  }

  async generateBriefing(input: GenerateBriefingInput): Promise<GeneratedBriefingDraft> {
    const allowedSources = new Set(input.candidates.map((candidate) => candidate.id));
    const options = {
      task: "briefing" as const, gatewayTask: "signal-briefing" as const, promptVersion: BRIEFING_PROMPT_VERSION,
      prompt: buildBriefingPrompt(input), schema: briefingDraftJsonSchema,
      validate: (value: unknown) => parseGeneratedBriefingDraft(value, allowedSources), runId: input.runId, repair: true,
    };
    return this.runJson(options);
  }

  async replyToAnnotation(input: AnnotationReplyInput): Promise<AnnotationReplyDraft> {
    return this.runJson({ task: "annotation-reply", gatewayTask: "signal-annotation-reply", promptVersion: REPLY_PROMPT_VERSION,
      prompt: buildAnnotationReplyPrompt(input), schema: annotationReplyJsonSchema, validate: parseAnnotationReplyDraft });
  }

  async extractMemory(input: MemoryExtractionInput): Promise<MemoryCandidateDraft | null> {
    const result = await this.runJson({ task: "memory-extraction", gatewayTask: "signal-memory-extraction", promptVersion: MEMORY_PROMPT_VERSION,
      prompt: buildMemoryPrompt(input), schema: memoryCandidateJsonSchema, validate: parseMemoryCandidateDraft });
    if (!result.shouldRemember) return null;
    if (result.scope === "belief" && result.content && !/^用户当前(的)?判断/.test(result.content)) {
      return { ...result, content: `用户当前判断：${result.content}` };
    }
    return result;
  }

  private async runJson<T>(options: JsonRunOptions<T>): Promise<T> {
    const invocationId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    let failureCode = "MODEL_REQUEST_FAILED";
    await this.invocations.start({ id: invocationId, task: options.task, runId: options.runId,
      model: this.env.ZX_SIGNAL_LLM_LABEL, promptVersion: options.promptVersion, startedAt });
    try {
      const response = await this.fetcher(this.env.ZX_SIGNAL_LLM_API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.env.ZX_SIGNAL_LLM_API_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-Request-Id": invocationId,
        },
        body: JSON.stringify({
          task: options.gatewayTask,
          messages: [
            { role: "system", content: `${options.prompt.system}\nThe output JSON must match this schema exactly: ${JSON.stringify(options.schema)}` },
            { role: "user", content: options.prompt.user },
          ],
          temperature: 0,
          maxOutputTokens: options.gatewayTask === "signal-briefing" || options.gatewayTask === "signal-editorial-filter" ? 4_000
            : options.gatewayTask === "signal-memory-extraction" ? 800 : 1_200,
          responseFormat: { type: "json" },
        }),
      });
      const contentLength = Number(response.headers.get("content-length") ?? "0");
      if (contentLength > 512 * 1024) throw new SignalValidationError("Gateway response was too large");
      const raw = await response.text();
      if (new TextEncoder().encode(raw).byteLength > 512 * 1024) throw new SignalValidationError("Gateway response was too large");
      let payload: unknown;
      try { payload = JSON.parse(raw) as unknown; }
      catch (cause) { throw new SignalValidationError(`Gateway returned invalid JSON: ${cause instanceof Error ? cause.message : "parse failure"}`); }
      if (!response.ok) {
        const root = object(payload);
        const error = object(root?.error);
        const code = typeof error?.code === "string" ? error.code : `HTTP_${response.status}`;
        failureCode = `GATEWAY_${response.status}_${code}`.slice(0, 120);
        throw new SignalError("MODEL_REQUEST_FAILED", `Project AI gateway failed with ${code}`, 502);
      }
      const result = gatewaySuccess(payload);
      const value = options.validate(responseValue(result));
      await this.invocations.complete(invocationId, {
        model: `${result.data.provider}/${result.data.model}`,
        inputTokens: result.data.usage?.inputTokens,
        outputTokens: result.data.usage?.outputTokens,
      });
      return value;
    } catch (cause) {
      const invalid = cause instanceof SignalValidationError || cause instanceof SyntaxError;
      await this.invocations.fail(invocationId, invalid ? "INVALID_MODEL_OUTPUT" : failureCode);
      console.error(JSON.stringify({
        event: "signal.model.failed",
        task: options.task,
        model: this.env.ZX_SIGNAL_LLM_LABEL,
        promptVersion: options.promptVersion,
        errorType: cause instanceof Error ? cause.name : "Unknown",
        errorMessage: cause instanceof Error ? cause.message.slice(0, 240) : "Unknown model failure",
      }));
      if (invalid && options.repair) return this.repairJson(options, cause);
      throw new SignalError(invalid ? "INVALID_MODEL_OUTPUT" : "MODEL_REQUEST_FAILED",
        invalid ? "The model response did not match the Signal schema" : "The model request failed", invalid ? 400 : 502, cause);
    }
  }

  private async repairJson<T>(options: JsonRunOptions<T>, cause: unknown): Promise<T> {
    return this.runJson({
      ...options,
      task: "briefing-repair",
      prompt: {
        system: `${options.prompt.system}\nThis is the single allowed repair attempt. Produce a complete replacement matching the schema.`,
        user: `${options.prompt.user}\nValidation error: ${cause instanceof Error ? cause.message.slice(0, 300) : "invalid output"}`,
      },
      repair: false,
    });
  }
}
