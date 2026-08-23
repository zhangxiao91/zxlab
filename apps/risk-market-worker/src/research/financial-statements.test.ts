import assert from "node:assert/strict";
import test from "node:test";
import {
  EastmoneyCninfoFinancialStatementAdapter,
  deriveStandaloneQuarter,
  financialRatioChange,
  parseCninfoFilingIdentities,
  parseEastmoneyFinancialStatementBatch,
  subtractDecimal,
} from "./financial-statements.ts";

const response = (rows: unknown[]) => ({ success: true, result: { data: rows } });

test("financial adapter retains Eastmoney values when CNINFO is unavailable", async () => {
  const payloadByReport = new Map<string, unknown>([
    ["RPT_DMSK_FN_INCOME", response([{ REPORT_DATE: "2026-06-30", NOTICE_DATE: "2026-08-20", REPORT_TYPE_CODE: "002", DATA_STATE: "F", TOTAL_OPERATE_INCOME: "120", OPERATE_PROFIT: "25", PARENT_NETPROFIT: "20" }])],
    ["RPT_DMSK_FN_CASHFLOW", response([{ REPORT_DATE: "2026-06-30", NOTICE_DATE: "2026-08-20", REPORT_TYPE_CODE: "002", DATA_STATE: "F", NETCASH_OPERATE: "18" }])],
    ["RPT_DMSK_FN_BALANCE", response([{ REPORT_DATE: "2026-06-30", NOTICE_DATE: "2026-08-20", REPORT_TYPE_CODE: "002", DATA_STATE: "F", TOTAL_ASSETS: "900" }])],
  ]);
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "datacenter-web.eastmoney.com") {
      return Response.json(payloadByReport.get(url.searchParams.get("reportName")!)!);
    }
    throw new TypeError("network unavailable");
  };
  const adapter = new EastmoneyCninfoFinancialStatementAdapter({
    fetcher,
    now: () => "2026-08-20T05:00:00.000Z",
  });

  const batch = await adapter.loadArtifacts({
    instrumentId: "SSE:600000",
    observationCutoff: "2026-08-20T05:00:00.000Z",
  });

  assert.equal(batch.candidates.length, 3);
  assert.ok(batch.candidates.every((candidate) => candidate.kind === "financial_statement.v1"));
  assert.ok(batch.candidates.every((candidate) => candidate.warnings?.includes("OFFICIAL_FILING_UNCORROBORATED")));
  assert.deepEqual(batch.relations, []);
});

test("financial adapter rejects an upstream body that exceeds the bounded response budget", async () => {
  const payload = response([{ REPORT_DATE: "2026-06-30", NOTICE_DATE: "2026-08-20", REPORT_TYPE_CODE: "002", DATA_STATE: "F", TOTAL_OPERATE_INCOME: "120" }]);
  const adapter = new EastmoneyCninfoFinancialStatementAdapter({
    fetcher: async (input) => {
      if (new URL(String(input)).hostname !== "datacenter-web.eastmoney.com") throw new TypeError("network unavailable");
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "2000001" },
      });
    },
    now: () => "2026-08-20T05:00:00.000Z",
  });

  await assert.rejects(adapter.loadArtifacts({
    instrumentId: "SSE:600000",
    observationCutoff: "2026-08-20T05:00:00.000Z",
  }), /FINANCIAL_PROVIDER_EXHAUSTED/);
});

test("financial adapter bounds chunked upstream bodies without trusting content-length", async () => {
  const adapter = new EastmoneyCninfoFinancialStatementAdapter({
    fetcher: async (input) => {
      if (new URL(String(input)).hostname !== "datacenter-web.eastmoney.com") throw new TypeError("network unavailable");
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(1_000_001));
          controller.enqueue(new Uint8Array(1_000_000));
          controller.close();
        },
      }));
    },
    now: () => "2026-08-20T05:00:00.000Z",
  });

  await assert.rejects(adapter.loadArtifacts({
    instrumentId: "SSE:600000",
    observationCutoff: "2026-08-20T05:00:00.000Z",
  }), /FINANCIAL_PROVIDER_EXHAUSTED/);
});

test("financial parser uses NOTICE_DATE and preserves five canonical metrics across three statements", () => {
  const parsed = parseEastmoneyFinancialStatementBatch("SSE:600000", {
    income: response([{
      REPORT_DATE: "2026-06-30 00:00:00",
      NOTICE_DATE: "2026-08-20 00:00:00",
      REPORT_TYPE_CODE: "002",
      DATA_STATE: "F",
      TOTAL_OPERATE_INCOME: 120,
      OPERATE_PROFIT: 25,
      PARENT_NETPROFIT: 20,
    }]),
    cashFlow: response([{
      REPORT_DATE: "2026-06-30 00:00:00",
      NOTICE_DATE: "2026-08-20 00:00:00",
      REPORT_TYPE_CODE: "002",
      DATA_STATE: "F",
      NETCASH_OPERATE: 18,
    }]),
    balance: response([{
      REPORT_DATE: "2026-06-30 00:00:00",
      NOTICE_DATE: "2026-08-20 00:00:00",
      REPORT_TYPE_CODE: "002",
      DATA_STATE: "F",
      TOTAL_ASSETS: 900,
    }]),
  }, "2026-08-20T05:00:00.000Z");

  assert.equal(parsed.length, 3);
  assert.ok(parsed.every((candidate) => candidate.sourceAsOf === "2026-08-19T16:00:00.000Z"));
  assert.deepEqual(parsed.flatMap((candidate) => candidate.projection?.cells.map((cell) => cell.metric) ?? []).sort(), [
    "net_cash_flow_from_operating_activities",
    "net_profit_attributable_to_parent",
    "operating_profit",
    "operating_revenue",
    "total_assets",
  ]);
});

test("financial parser rejects report dates used as a substitute for missing notice dates", () => {
  assert.throws(() => parseEastmoneyFinancialStatementBatch("SSE:600000", {
    income: response([{ REPORT_DATE: "2026-06-30", TOTAL_OPERATE_INCOME: 120 }]),
    cashFlow: response([]),
    balance: response([]),
  }, "2026-08-20T01:00:00.000Z"), /FINANCIAL_STATEMENT_INTEGRITY_FAILURE/);
});

test("CNINFO parser keeps official filing identity without treating titles as financial values", () => {
  const filings = parseCninfoFilingIdentities("SSE:600000", {
    announcements: [{
      announcementId: "1212345678",
      announcementTitle: "浦发银行2026年半年度报告",
      announcementTime: 1787198400000,
      adjunctUrl: "finalpage/2026-08-20/1212345678.PDF",
    }],
  }, "2026-08-20T05:00:00.000Z");
  assert.equal(filings.length, 1);
  assert.equal(filings[0].projection?.filingId, "1212345678");
  assert.equal(filings[0].projection?.reportPeriodEnd, "2026-06-30T00:00:00.000Z");
  assert.equal(filings[0].sourceAsOf, "2026-08-20T04:00:00.000Z");
});

test("CNINFO parser deterministically prefers a full report over its same-period summary", () => {
  const filings = parseCninfoFilingIdentities("SSE:600000", {
    announcements: [
      { announcementId: "1225062326", announcementTitle: "浦发银行2025年年度报告摘要", announcementTime: 1787198400000, adjunctUrl: "summary.pdf" },
      { announcementId: "1225062336", announcementTitle: "浦发银行2025年年度报告", announcementTime: 1787198400000, adjunctUrl: "full.pdf" },
    ],
  }, "2026-08-20T05:00:00.000Z");
  assert.equal(filings.length, 1);
  assert.equal(filings[0].projection?.filingId, "1225062336");
});

test("fixed decimal operators derive quarters exactly and refuse non-positive comparison bases", () => {
  assert.equal(subtractDecimal("120.25", "50.10"), "70.15");
  assert.equal(subtractDecimal("50.10", "120.25"), "-70.15");
  assert.equal(financialRatioChange("120", "100"), "0.2");
  assert.equal(financialRatioChange("90", "100"), "-0.1");
  assert.equal(financialRatioChange("100", "0"), null);
  assert.equal(financialRatioChange("100", "-10"), null);
});

test("quarter operator fixes the Q1, Q2, Q3, and Q4 cumulative-report rules", () => {
  assert.equal(deriveStandaloneQuarter({ periodEnd: "2026-03-31T00:00:00.000Z", currentCumulative: "50" }), "50");
  assert.equal(deriveStandaloneQuarter({ periodEnd: "2026-06-30T00:00:00.000Z", currentCumulative: "120", previousCumulative: "50" }), "70");
  assert.equal(deriveStandaloneQuarter({ periodEnd: "2026-09-30T00:00:00.000Z", currentCumulative: "210", previousCumulative: "120" }), "90");
  assert.equal(deriveStandaloneQuarter({ periodEnd: "2026-12-31T00:00:00.000Z", currentCumulative: "320", previousCumulative: "210" }), "110");
  assert.throws(() => deriveStandaloneQuarter({ periodEnd: "2026-06-30T00:00:00.000Z", currentCumulative: "120" }), /COMPARABLE_PERIOD_MISSING/);
});
