import {
  annotationReplyJsonSchema,
  briefingDraftJsonSchema,
  memoryCandidateJsonSchema,
  parseAnnotationReplyDraft,
  parseGeneratedBriefingDraft,
  parseMemoryCandidateDraft,
  SignalValidationError,
  type AnnotationAction,
  type AnnotationReplyDraft,
  type BriefingItem,
  type CandidateSignal,
  type GeneratedBriefingDraft,
  type MemoryCandidateDraft,
  type MemoryEntry,
} from "@zxlab/signal-schema";
import { SignalError } from "../lib/errors";
import { ModelInvocationRepository, type InvocationTask } from "../repositories/model-invocation-repository";
import {
  BRIEFING_PROMPT_VERSION,
  MEMORY_PROMPT_VERSION,
  REPLY_PROMPT_VERSION,
  buildAnnotationReplyPrompt,
  buildBriefingPrompt,
  buildMemoryPrompt,
} from "./prompts";

export interface GenerateBriefingInput { date: string; candidates: CandidateSignal[]; memories: MemoryEntry[]; runId: string; }
export interface AnnotationReplyInput { item: BriefingItem; selectedText: string; comment: string; action: AnnotationAction; memories: MemoryEntry[]; }
export interface MemoryExtractionInput { item: BriefingItem; selectedText: string; comment: string; action: AnnotationAction; reply: string; }

export interface SignalLLM {
  generateBriefing(input: GenerateBriefingInput): Promise<GeneratedBriefingDraft>;
  replyToAnnotation(input: AnnotationReplyInput): Promise<AnnotationReplyDraft>;
  extractMemory(input: MemoryExtractionInput): Promise<MemoryCandidateDraft | null>;
}

interface JsonRunOptions<T> {
  task: InvocationTask;
  model: string;
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

function responseValue(result: unknown): unknown {
  const root = object(result);
  if (!root || !("response" in root)) throw new SignalValidationError("Model response did not contain response");
  const response = root.response;
  if (typeof response === "string") {
    const cleaned = response.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    return JSON.parse(cleaned) as unknown;
  }
  return response;
}

function usageValue(result: unknown): { inputTokens?: number; outputTokens?: number } | undefined {
  const usage = object(object(result)?.usage);
  if (!usage) return undefined;
  return {
    inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
    outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
  };
}

export class WorkersSignalLLM implements SignalLLM {
  private readonly invocations: ModelInvocationRepository;

  constructor(private readonly env: Env) {
    this.invocations = new ModelInvocationRepository(env.DB);
  }

  async generateBriefing(input: GenerateBriefingInput): Promise<GeneratedBriefingDraft> {
    const allowedSources = new Set(input.candidates.map((candidate) => candidate.id));
    const options = {
      task: "briefing" as const, model: this.env.ZX_SIGNAL_EDITOR_MODEL, promptVersion: BRIEFING_PROMPT_VERSION,
      prompt: buildBriefingPrompt(input), schema: briefingDraftJsonSchema,
      validate: (value: unknown) => parseGeneratedBriefingDraft(value, allowedSources), runId: input.runId, repair: true,
    };
    return this.runJson(options);
  }

  async replyToAnnotation(input: AnnotationReplyInput): Promise<AnnotationReplyDraft> {
    return this.runJson({ task: "annotation-reply", model: this.env.ZX_SIGNAL_REPLY_MODEL, promptVersion: REPLY_PROMPT_VERSION,
      prompt: buildAnnotationReplyPrompt(input), schema: annotationReplyJsonSchema, validate: parseAnnotationReplyDraft });
  }

  async extractMemory(input: MemoryExtractionInput): Promise<MemoryCandidateDraft | null> {
    const result = await this.runJson({ task: "memory-extraction", model: this.env.ZX_SIGNAL_MEMORY_MODEL, promptVersion: MEMORY_PROMPT_VERSION,
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
    await this.invocations.start({ id: invocationId, task: options.task, runId: options.runId, model: options.model, promptVersion: options.promptVersion, startedAt });
    try {
      const result = await this.env.AI.run(options.model, {
        messages: [
          { role: "system", content: options.prompt.system },
          { role: "user", content: options.prompt.user },
        ],
        temperature: 0,
        max_tokens: options.task === "briefing" ? 4_000 : 1_200,
        response_format: { type: "json_schema", json_schema: options.schema },
      }, {
        gateway: { id: this.env.ZX_SIGNAL_GATEWAY_ID, metadata: { task: options.task, promptVersion: options.promptVersion, runId: options.runId ?? "none" } },
      });
      const value = options.validate(responseValue(result));
      await this.invocations.complete(invocationId, usageValue(result));
      return value;
    } catch (cause) {
      const invalid = cause instanceof SignalValidationError || cause instanceof SyntaxError;
      await this.invocations.fail(invocationId, invalid ? "INVALID_MODEL_OUTPUT" : "MODEL_REQUEST_FAILED");
      console.error(JSON.stringify({
        event: "signal.model.failed",
        task: options.task,
        model: options.model,
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
