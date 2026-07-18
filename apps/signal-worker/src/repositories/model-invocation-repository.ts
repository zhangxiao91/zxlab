export type InvocationTask = "editorial-filter" | "briefing" | "briefing-repair" | "annotation-reply" | "memory-extraction";

export interface InvocationContext {
  id: string;
  task: InvocationTask;
  runId?: string;
  annotationId?: string;
  model: string;
  promptVersion: string;
  startedAt: string;
}

export class ModelInvocationRepository {
  constructor(private readonly db: D1Database) {}

  async start(context: InvocationContext): Promise<void> {
    await this.db.prepare(`INSERT INTO model_invocations
      (id, task, run_id, annotation_id, model, prompt_version, status, started_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`)
      .bind(context.id, context.task, context.runId ?? null, context.annotationId ?? null, context.model, context.promptVersion, context.startedAt)
      .run();
  }

  async complete(id: string, input: {
    model: string;
    inputTokens?: number;
    outputTokens?: number;
  }): Promise<void> {
    await this.db.prepare(`UPDATE model_invocations
      SET status = 'succeeded', completed_at = ?, model = ?, input_tokens = ?, output_tokens = ? WHERE id = ?`)
      .bind(new Date().toISOString(), input.model, input.inputTokens ?? null, input.outputTokens ?? null, id).run();
  }

  async fail(id: string, errorCode: string): Promise<void> {
    await this.db.prepare(`UPDATE model_invocations SET status = 'failed', completed_at = ?, error_code = ? WHERE id = ?`)
      .bind(new Date().toISOString(), errorCode, id).run();
  }
}
