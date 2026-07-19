import type { AnnotationInput, AnnotationResponse, MemoryCandidate } from "@zxlab/signal-schema";
import { AnnotationRepository } from "../repositories/annotation-repository";
import type { SignalLLM } from "./llm";
import { MemoryRepository } from "./memory-repository";

export interface AnnotationResponseObserver {
  replyDelta?(text: string): void;
  replyReady?(response: Pick<AnnotationResponse, "annotation" | "reply">): void;
  memoryReady?(memoryCandidate?: MemoryCandidate): void;
}

export class AnnotationResponder {
  private readonly annotations: AnnotationRepository;
  private readonly memories: MemoryRepository;

  constructor(private readonly env: Env, private readonly llm: SignalLLM) {
    this.annotations = new AnnotationRepository(env.DB);
    this.memories = new MemoryRepository(env.DB);
  }

  async respond(input: AnnotationInput, observer: AnnotationResponseObserver = {}): Promise<AnnotationResponse> {
    const item = await this.annotations.getItemContext(input.briefingId, input.briefingItemId);
    const relevantMemories = await this.memories.relevantTo(`${item.title}\n${item.summary}\n${input.selectedText}\n${input.comment}`);
    const annotationId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const replyDraft = await this.llm.replyToAnnotation(
      { item, selectedText: input.selectedText, comment: input.comment, action: input.action, memories: relevantMemories },
      { onDelta: (text) => observer.replyDelta?.(text) },
    );
    const annotation = { id: annotationId, briefingId: input.briefingId, briefingItemId: input.briefingItemId,
      selectedText: input.selectedText, comment: input.comment, action: input.action, createdAt };
    const reply = { id: crypto.randomUUID(), annotationId, content: replyDraft.reply, createdAt: new Date().toISOString(), model: this.env.ZX_SIGNAL_LLM_LABEL };
    observer.replyReady?.({ annotation, reply });
    const memoryDraft = await this.llm.extractMemory({ item, selectedText: input.selectedText, comment: input.comment, action: input.action, reply: replyDraft.reply });
    let memoryCandidate: MemoryCandidate | undefined;
    if (memoryDraft?.shouldRemember && memoryDraft.scope && memoryDraft.content && memoryDraft.confidence !== undefined && memoryDraft.reason) {
      memoryCandidate = { id: crypto.randomUUID(), annotationId, scope: memoryDraft.scope,
        scopeKey: memoryDraft.scope === "project" ? "zxlab" : undefined, content: memoryDraft.content,
        confidence: memoryDraft.confidence, reason: memoryDraft.reason, status: "proposed", createdAt: new Date().toISOString() };
    }
    observer.memoryReady?.(memoryCandidate);
    await this.annotations.save({ request: input, annotation, reply, memoryCandidate });
    return { annotation, reply, memoryCandidate };
  }
}
