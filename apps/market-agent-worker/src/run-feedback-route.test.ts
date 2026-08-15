import assert from "node:assert/strict";
import test from "node:test";
import { D1RunRepository } from "./d1-repository.ts";
import { handleRunFeedbackRequest } from "./run-feedback-route.ts";

test("feedback POST treats JSON null as invalid feedback instead of an internal error", async () => {
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              if (sql !== "SELECT * FROM agent_runs WHERE id = ?") return null;
              return {
                id: "run-owner",
                profile_id: "profile-owner",
                workflow: "close_review",
                trigger: "manual",
                status: "success",
                idempotency_key: "feedback-null-test",
                command_hash: "sha256:feedback-null-test",
                revision_of_run_id: null,
                portfolio_snapshot_id: null,
                attempt: 1,
                recovery_generation: 0,
                created_at: "2026-08-15T00:00:00.000Z",
                updated_at: "2026-08-15T00:00:00.000Z",
                evidence_fingerprint: null,
                failure_json: null,
              };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  const request = new Request("https://market-agent.example/runs/run-owner/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "null",
  });

  const response = await handleRunFeedbackRequest(
    request,
    new D1RunRepository(db),
    "run-owner",
    "profile-owner",
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "INVALID_FEEDBACK" });
});
