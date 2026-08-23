import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { SignalError } from "../src/lib/errors";
import {
  DailyPipelineRunner,
  type DailyPipelineExecution,
  type DailyPipelineStage,
} from "../src/services/daily-pipeline-runner";

const scheduledTime = Date.parse("2026-08-21T23:30:00.000Z");

describe("DailyPipelineRunner", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM daily_pipeline_stage_events"),
      env.DB.prepare("DELETE FROM daily_pipeline_runs"),
    ]);
  });

  it("reuses the completed collection run when generation is retried", async () => {
    const collectionInputs: Array<string | undefined> = [];
    let attempts = 0;
    const execute: DailyPipelineExecution = async (input) => {
      attempts += 1;
      collectionInputs.push(input.collectionRunId);
      await input.onStage("collecting");
      await input.onCollectionReady("collection-stable");
      await input.onStage("filtering");
      if (attempts === 1) throw new SignalError("MODEL_REQUEST_FAILED", "private upstream detail", 502);
      for (const stage of ["generating", "validating", "publishing"] satisfies DailyPipelineStage[]) {
        await input.onStage(stage);
      }
      return { collectionRunId: "collection-stable", briefingId: "briefing-1", briefingRunId: "briefing-run-1" };
    };
    const runner = new DailyPipelineRunner(env.DB, {
      execute,
      refreshPages: async () => "triggered",
      now: () => new Date("2026-08-22T00:00:00.000Z"),
    });

    const first = await runner.run(scheduledTime);
    const second = await runner.run(scheduledTime, { force: true });

    expect(first).toMatchObject({ status: "failed", currentStage: "filtering", errorCode: "MODEL_REQUEST_FAILED", attemptCount: 1 });
    expect(second).toMatchObject({
      status: "succeeded",
      currentStage: "refreshing",
      collectionRunId: "collection-stable",
      briefingId: "briefing-1",
      pagesRefreshStatus: "triggered",
      attemptCount: 2,
    });
    expect(collectionInputs).toEqual(["daily:2026-08-22:collection", "collection-stable"]);
  });

  it("retries only Pages refresh after the briefing was published", async () => {
    let executions = 0;
    let refreshes = 0;
    const runner = new DailyPipelineRunner(env.DB, {
      execute: async (input) => {
        executions += 1;
        await input.onStage("collecting");
        await input.onCollectionReady("collection-2");
        for (const stage of ["filtering", "generating", "validating", "publishing"] satisfies DailyPipelineStage[]) {
          await input.onStage(stage);
        }
        return { collectionRunId: "collection-2", briefingId: "briefing-2", briefingRunId: "briefing-run-2" };
      },
      refreshPages: async () => {
        refreshes += 1;
        if (refreshes === 1) throw new Error("deploy hook response body must stay private");
        return "triggered";
      },
      now: () => new Date("2026-08-22T00:05:00.000Z"),
    });

    const first = await runner.run(scheduledTime);
    const second = await runner.run(scheduledTime, { force: true });

    expect(first).toMatchObject({ status: "failed", currentStage: "refreshing", errorCode: "PAGES_REFRESH_FAILED" });
    expect(second).toMatchObject({ status: "succeeded", pagesRefreshStatus: "triggered", attemptCount: 2 });
    expect(executions).toBe(1);
    expect(refreshes).toBe(2);
  });

  it("force-refreshes Pages for a succeeded run without repeating the pipeline", async () => {
    let executions = 0;
    let refreshes = 0;
    const runner = new DailyPipelineRunner(env.DB, {
      execute: async (input) => {
        executions += 1;
        await input.onStage("collecting");
        await input.onCollectionReady("collection-published");
        for (const stage of ["filtering", "generating", "validating", "publishing"] satisfies DailyPipelineStage[]) {
          await input.onStage(stage);
        }
        return {
          collectionRunId: "collection-published",
          briefingId: "briefing-published",
          briefingRunId: "briefing-run-published",
        };
      },
      refreshPages: async () => {
        refreshes += 1;
        return refreshes === 1 ? "not-configured" : "triggered";
      },
      now: () => new Date("2026-08-22T00:07:00.000Z"),
    });

    const first = await runner.run(scheduledTime);
    const second = await runner.run(scheduledTime, { force: true });

    expect(first).toMatchObject({ status: "succeeded", pagesRefreshStatus: "not-configured", attemptCount: 1 });
    expect(second).toMatchObject({ status: "succeeded", pagesRefreshStatus: "triggered", attemptCount: 2 });
    expect(executions).toBe(1);
    expect(refreshes).toBe(2);
  });

  it("leases a daily run so concurrent triggers cannot execute it twice", async () => {
    let releaseExecution!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseExecution = resolve; });
    let executions = 0;
    const runner = new DailyPipelineRunner(env.DB, {
      execute: async (input) => {
        executions += 1;
        await input.onStage("collecting");
        await blocked;
        await input.onCollectionReady("collection-concurrent");
        return { collectionRunId: "collection-concurrent", briefingId: "briefing-concurrent", briefingRunId: "run-concurrent" };
      },
      refreshPages: async () => "triggered",
      now: () => new Date("2026-08-22T00:10:00.000Z"),
    });

    const firstPromise = runner.run(scheduledTime);
    await Promise.resolve();
    const concurrentPromise = runner.run(scheduledTime);
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseExecution();
    const concurrent = await concurrentPromise;
    const first = await firstPromise;

    expect(concurrent).toMatchObject({ status: "running", attemptCount: 1 });
    expect(first.status).toBe("succeeded");
    expect(executions).toBe(1);
  });
});
