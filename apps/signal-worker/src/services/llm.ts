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
import { GatewayRequestError, requestGatewayJson, responseValue } from "./gateway-client";

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

export class ProjectApiSignalLLM implements SignalLLM {
  private readonly invocations: ModelInvocationRepository;

  constructor(private readonly env: Env, private readonly fetcher: typeof fetch = (input, init) => fetch(input, init)) {
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
      const result = await requestGatewayJson({
        fetcher: this.fetcher,
        apiUrl: this.env.ZX_SIGNAL_LLM_API_URL,
        token: this.env.ZX_SIGNAL_LLM_API_TOKEN,
        invocationId,
        body: {
          task: options.gatewayTask,
          messages: [
            { role: "system", content: `${options.prompt.system}\nThe output JSON must match this schema exactly: ${JSON.stringify(options.schema)}` },
            { role: "user", content: options.prompt.user },
          ],
          temperature: 0,
          maxOutputTokens: options.gatewayTask === "signal-briefing" || options.gatewayTask === "signal-editorial-filter" ? 4_000
            : options.gatewayTask === "signal-memory-extraction" ? 800 : 1_200,
          responseFormat: { type: "json" },
        },
      });
      const value = options.validate(responseValue(result));
      await this.invocations.complete(invocationId, {
        model: `${result.data.provider}/${result.data.model}`,
        inputTokens: result.data.usage?.inputTokens,
        outputTokens: result.data.usage?.outputTokens,
      });
      return value;
    } catch (cause) {
      if (cause instanceof GatewayRequestError) failureCode = cause.failureCode;
      const invalid = cause instanceof SignalValidationError || cause instanceof SyntaxError;
      if (!invalid && failureCode === "MODEL_REQUEST_FAILED" && cause instanceof Error) {
        const detail = `${cause.name}_${cause.message}`.replace(/[^a-zA-Z0-9_.-]+/g, "_");
        failureCode = `FETCH_${detail}`.slice(0, 120);
      }
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
