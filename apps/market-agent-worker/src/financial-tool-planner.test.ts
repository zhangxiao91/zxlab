import assert from "node:assert/strict";
import test from "node:test";
import { GatewayFinancialToolPlanner } from "./financial-tool-planner.ts";

test("financial tool planner accepts only one bounded model selection", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const planner = new GatewayFinancialToolPlanner({
    apiUrl: "https://gateway.example/api/ai/generate",
    token: "secret",
    fetcher: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        requestId: "gateway-request-1",
        data: {
          json: { decision: "invoke", tool: "company_financial_update.v1" },
          provider: "deepseek",
          model: "deepseek-chat",
          fallbackIndex: 0,
        },
      });
    },
  });

  const decision = await planner.plan({
    scope: "news_and_announcements",
    selectedInstrumentId: "SSE:600000",
    question: "重点看财务变化",
  });

  assert.equal(requestBody?.task, "market-agent-financial-tool-plan");
  assert.equal((requestBody?.context as { operation?: string }).operation, "financial-tool-plan");
  assert.deepEqual(decision, {
    decision: "invoke",
    tool: "company_financial_update.v1",
    selection: {
      provider: "deepseek",
      model: "deepseek-chat",
      fallbackIndex: 0,
      gatewayRequestId: "gateway-request-1",
    },
  });
});

test("financial tool planner rejects arguments and explanatory text", async () => {
  for (const candidate of [
    { decision: "invoke", tool: "company_financial_update.v1", arguments: { provider: "eastmoney" } },
    { decision: "skip", reason: "not needed" },
  ]) {
    const planner = new GatewayFinancialToolPlanner({
      apiUrl: "https://gateway.example/api/ai/generate",
      token: "secret",
      fetcher: async () => Response.json({
        requestId: "gateway-request-2",
        data: { json: candidate, provider: "deepseek", model: "deepseek-chat", fallbackIndex: 0 },
      }),
    });
    await assert.rejects(planner.plan({
      scope: "news_and_announcements",
      selectedInstrumentId: "SSE:600000",
    }), /FINANCIAL_TOOL_PLANNER_INVALID_OUTPUT/);
  }
});
