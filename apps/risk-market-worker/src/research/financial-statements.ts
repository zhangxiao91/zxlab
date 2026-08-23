import type { FinancialMetricId } from "@zxlab/research-fact-schema";
import type {
  CapturedResearchArtifactBatch,
  FinancialStatementProjection,
  OfficialFilingProjection,
  ResearchArtifactCandidate,
} from "./artifact-store.ts";

export interface FinancialStatementPort {
  loadArtifacts(input: { instrumentId: string; observationCutoff: string }): Promise<CapturedResearchArtifactBatch>;
}

interface EastmoneyFinancialPayloads {
  income: unknown;
  cashFlow: unknown;
  balance: unknown;
}

const MAX_FINANCIAL_PROVIDER_BYTES = 2_000_000;

export class FinancialStatementProviderError extends Error {
  readonly code: "FINANCIAL_PROVIDER_EXHAUSTED" | "FINANCIAL_STATEMENT_INTEGRITY_FAILURE";
  constructor(code: FinancialStatementProviderError["code"]) { super(code); this.name = "FinancialStatementProviderError"; this.code = code; }
}

export class EastmoneyCninfoFinancialStatementAdapter implements FinancialStatementPort {
  private readonly fetcher: typeof fetch;
  private readonly now: () => string;
  constructor(input: { fetcher?: typeof fetch; now?: () => string } = {}) {
    this.fetcher = input.fetcher ?? fetch;
    this.now = input.now ?? (() => new Date().toISOString());
  }

  async loadArtifacts(input: { instrumentId: string; observationCutoff: string }): Promise<CapturedResearchArtifactBatch> {
    const retrievedAt = this.now();
    const code = instrumentCode(input.instrumentId);
    const [income, cashFlow, balance] = await Promise.all([
      this.eastmoney("RPT_DMSK_FN_INCOME", code.secuCode, "REPORT_DATE,NOTICE_DATE,REPORT_TYPE_CODE,DATA_STATE,TOTAL_OPERATE_INCOME,OPERATE_PROFIT,PARENT_NETPROFIT"),
      this.eastmoney("RPT_DMSK_FN_CASHFLOW", code.secuCode, "REPORT_DATE,NOTICE_DATE,REPORT_TYPE_CODE,DATA_STATE,NETCASH_OPERATE"),
      this.eastmoney("RPT_DMSK_FN_BALANCE", code.secuCode, "REPORT_DATE,NOTICE_DATE,REPORT_TYPE_CODE,DATA_STATE,TOTAL_ASSETS"),
    ]).catch((error) => {
      if (error instanceof FinancialStatementProviderError) throw error;
      throw new FinancialStatementProviderError("FINANCIAL_PROVIDER_EXHAUSTED");
    });
    const financial = parseEastmoneyFinancialStatementBatch(input.instrumentId, { income, cashFlow, balance }, retrievedAt)
      .filter((candidate) => Date.parse(candidate.sourceAsOf) <= Date.parse(input.observationCutoff));
    let filings: ResearchArtifactCandidate[] = [];
    try {
      const orgId = await this.cninfoOrgId(code.symbol);
      const cninfo = await this.cninfo(code.symbol, orgId, code.exchange, input.observationCutoff);
      filings = parseCninfoFilingIdentities(input.instrumentId, cninfo, retrievedAt)
        .filter((candidate) => Date.parse(candidate.sourceAsOf) <= Date.parse(input.observationCutoff));
    } catch (error) {
      if (error instanceof FinancialStatementProviderError && error.code === "FINANCIAL_STATEMENT_INTEGRITY_FAILURE") throw error;
    }
    const relations: NonNullable<CapturedResearchArtifactBatch["relations"]> = [];
    const candidates = financial.map((candidate) => {
      const projection = candidate.projection as FinancialStatementProjection;
      const matching = filings
        .filter((filing) => (filing.projection as OfficialFilingProjection).reportPeriodEnd === projection.reportPeriod.end)
        .sort((left, right) => right.sourceAsOf.localeCompare(left.sourceAsOf));
      const filing = matching[0];
      if (!filing) return { ...candidate, warnings: [...(candidate.warnings ?? []), "OFFICIAL_FILING_UNCORROBORATED"] };
      relations.push({ fromLogicalKey: candidate.logicalKey, toLogicalKey: filing.logicalKey, relation: "corroborated_by" });
      return {
        ...candidate,
        payload: { ...(candidate.payload as Record<string, unknown>), officialFilingLogicalKey: filing.logicalKey },
      };
    });
    return { candidates: [...candidates, ...filings], relations };
  }

  private async eastmoney(reportName: string, secuCode: string, columns: string): Promise<unknown> {
    const url = new URL("https://datacenter-web.eastmoney.com/api/data/v1/get");
    url.search = new URLSearchParams({
      reportName,
      columns,
      filter: `(SECUCODE=\"${secuCode}\")`,
      pageNumber: "1",
      pageSize: "12",
      sortColumns: "REPORT_DATE,NOTICE_DATE",
      sortTypes: "-1,-1",
      source: "WEB",
      client: "WEB",
    }).toString();
    const response = await this.fetcher(url, { headers: { referer: "https://data.eastmoney.com/" }, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new FinancialStatementProviderError("FINANCIAL_PROVIDER_EXHAUSTED");
    return boundedProviderJson(response);
  }

  private async cninfoOrgId(symbol: string): Promise<string> {
    const response = await this.fetcher("https://www.cninfo.com.cn/new/information/topSearch/query", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", origin: "https://www.cninfo.com.cn", referer: "https://www.cninfo.com.cn/new/commonUrl/pageOfSearch" },
      body: new URLSearchParams({ keyWord: symbol, maxNum: "10" }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new FinancialStatementProviderError("FINANCIAL_PROVIDER_EXHAUSTED");
    const payload = await boundedProviderJson(response);
    if (!Array.isArray(payload)) throw new FinancialStatementProviderError("FINANCIAL_STATEMENT_INTEGRITY_FAILURE");
    const exact = payload.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).code === symbol) as Record<string, unknown> | undefined;
    if (!exact || typeof exact.orgId !== "string" || !exact.orgId) throw new FinancialStatementProviderError("FINANCIAL_PROVIDER_EXHAUSTED");
    return exact.orgId;
  }

  private async cninfo(symbol: string, orgId: string, exchange: "SSE" | "SZSE", observationCutoff: string): Promise<unknown> {
    const end = chinaDate(observationCutoff);
    const startDate = new Date(`${end}T00:00:00.000Z`);
    startDate.setUTCFullYear(startDate.getUTCFullYear() - 3);
    const body = new URLSearchParams({
      pageNum: "1",
      pageSize: "36",
      column: exchange === "SSE" ? "sse" : "szse",
      tabName: "fulltext",
      plate: "",
      stock: `${symbol},${orgId}`,
      searchkey: "",
      secid: "",
      category: "category_ndbg_szsh;category_bndbg_szsh;category_yjdbg_szsh;category_sjdbg_szsh",
      trade: "",
      seDate: `${startDate.toISOString().slice(0, 10)}~${end}`,
      sortName: "time",
      sortType: "desc",
      isHLtitle: "false",
    });
    const response = await this.fetcher("https://www.cninfo.com.cn/new/hisAnnouncement/query", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8", origin: "https://www.cninfo.com.cn", referer: "https://www.cninfo.com.cn/new/commonUrl/pageOfSearch" },
      body,
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new FinancialStatementProviderError("FINANCIAL_PROVIDER_EXHAUSTED");
    return boundedProviderJson(response);
  }
}

async function boundedProviderJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FINANCIAL_PROVIDER_BYTES) {
    throw new FinancialStatementProviderError("FINANCIAL_PROVIDER_EXHAUSTED");
  }
  if (!response.body) throw new FinancialStatementProviderError("FINANCIAL_STATEMENT_INTEGRITY_FAILURE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > MAX_FINANCIAL_PROVIDER_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new FinancialStatementProviderError("FINANCIAL_PROVIDER_EXHAUSTED");
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    if (error instanceof FinancialStatementProviderError) throw error;
    throw new FinancialStatementProviderError("FINANCIAL_PROVIDER_EXHAUSTED");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new FinancialStatementProviderError("FINANCIAL_STATEMENT_INTEGRITY_FAILURE");
  }
}

export function parseEastmoneyFinancialStatementBatch(instrumentId: string, payloads: EastmoneyFinancialPayloads, retrievedAt: string): ResearchArtifactCandidate[] {
  const definitions: Array<{
    statementType: FinancialStatementProjection["statementType"];
    payload: unknown;
    metrics: Array<[FinancialMetricId, string]>;
  }> = [
    { statementType: "income", payload: payloads.income, metrics: [["operating_revenue", "TOTAL_OPERATE_INCOME"], ["operating_profit", "OPERATE_PROFIT"], ["net_profit_attributable_to_parent", "PARENT_NETPROFIT"]] },
    { statementType: "cash_flow", payload: payloads.cashFlow, metrics: [["net_cash_flow_from_operating_activities", "NETCASH_OPERATE"]] },
    { statementType: "balance_sheet", payload: payloads.balance, metrics: [["total_assets", "TOTAL_ASSETS"]] },
  ];
  try {
    const parsed = definitions.flatMap((definition) => rows(definition.payload).flatMap((row) => {
      const reportPeriod = reportingPeriod(requiredDate(row.REPORT_DATE));
      const noticeDate = requiredDate(row.NOTICE_DATE);
      const sourceAsOf = chinaMidnight(noticeDate);
      if (Date.parse(sourceAsOf) > Date.parse(retrievedAt)) throw new Error("notice date is after retrieval");
      const cells = definition.metrics.flatMap(([metric, field]) => row[field] == null ? [] : [{ metric, value: canonicalDecimal(row[field]), unit: "CNY" as const }]);
      if (!cells.length) return [];
      const reportTypeCode = requiredText(row.REPORT_TYPE_CODE);
      const dataState = requiredText(row.DATA_STATE);
      const projection: FinancialStatementProjection = { statementType: definition.statementType, reportPeriod, reportTypeCode, dataState, cells };
      return [{
        kind: "financial_statement.v1" as const,
        subjectId: instrumentId,
        logicalKey: `${instrumentId}:${definition.statementType}:${reportPeriod.end}:${reportPeriod.basis}`,
        provider: "eastmoney-financials",
        providerVersion: "eastmoney-financials.v1",
        sourceAsOf,
        retrievedAt,
        payload: projection,
        rawPayload: { reportName: definition.statementType, row },
        projection,
      }];
    }));
    const latest = new Map<string, ResearchArtifactCandidate>();
    for (const candidate of parsed) {
      const existing = latest.get(candidate.logicalKey);
      if (!existing || compareFinancialRevision(candidate, existing) > 0) latest.set(candidate.logicalKey, candidate);
    }
    return [...latest.values()].sort((left, right) => left.logicalKey.localeCompare(right.logicalKey));
  } catch {
    throw new FinancialStatementProviderError("FINANCIAL_STATEMENT_INTEGRITY_FAILURE");
  }
}

function compareFinancialRevision(left: ResearchArtifactCandidate, right: ResearchArtifactCandidate): number {
  return left.sourceAsOf.localeCompare(right.sourceAsOf)
    || JSON.stringify(left.rawPayload).localeCompare(JSON.stringify(right.rawPayload));
}

export function parseCninfoFilingIdentities(instrumentId: string, payload: unknown, retrievedAt: string): ResearchArtifactCandidate[] {
  const root = payload as { announcements?: unknown };
  if (!root || !Array.isArray(root.announcements)) throw new FinancialStatementProviderError("FINANCIAL_STATEMENT_INTEGRITY_FAILURE");
  try {
    const parsed = root.announcements.flatMap((value) => {
      const row = value as Record<string, unknown>;
      const title = stripHtml(requiredText(row.announcementTitle));
      const period = filingPeriod(title);
      if (!period) return [];
      const filingId = requiredText(row.announcementId);
      const sourceAsOf = epochIso(row.announcementTime);
      if (Date.parse(sourceAsOf) > Date.parse(retrievedAt)) return [];
      const adjunct = requiredText(row.adjunctUrl).replace(/^\/+/, "");
      const projection: OfficialFilingProjection = {
        filingId,
        reportPeriodEnd: period.end,
        reportType: period.type,
        title,
        publishedAt: sourceAsOf,
        url: `https://static.cninfo.com.cn/${adjunct}`,
      };
      return [{
        kind: "official_filing_identity.v1" as const,
        subjectId: instrumentId,
        logicalKey: `${instrumentId}:official-filing:${period.end}:${period.type}`,
        provider: "cninfo-official-filings",
        providerVersion: "cninfo-official-filings.v1",
        sourceAsOf,
        retrievedAt,
        payload: projection,
        rawPayload: { announcement: row },
        projection,
      }];
    });
    const fullPeriods = new Set(parsed.flatMap((candidate) => {
      const projection = candidate.projection as OfficialFilingProjection;
      return projection.title.includes("摘要") ? [] : [projection.reportPeriodEnd];
    }));
    const latest = new Map<string, ResearchArtifactCandidate>();
    for (const candidate of parsed) {
      const projection = candidate.projection as OfficialFilingProjection;
      if (projection.title.includes("摘要") && fullPeriods.has(projection.reportPeriodEnd)) continue;
      const existing = latest.get(candidate.logicalKey);
      if (!existing || compareOfficialRevision(candidate, existing) > 0) latest.set(candidate.logicalKey, candidate);
    }
    return [...latest.values()].sort((left, right) => left.logicalKey.localeCompare(right.logicalKey));
  } catch {
    throw new FinancialStatementProviderError("FINANCIAL_STATEMENT_INTEGRITY_FAILURE");
  }
}

function compareOfficialRevision(left: ResearchArtifactCandidate, right: ResearchArtifactCandidate): number {
  const source = left.sourceAsOf.localeCompare(right.sourceAsOf);
  if (source) return source;
  const leftProjection = left.projection as OfficialFilingProjection;
  const rightProjection = right.projection as OfficialFilingProjection;
  const revisionRank = (title: string) => /更正|修订/.test(title) ? 1 : 0;
  return revisionRank(leftProjection.title) - revisionRank(rightProjection.title) || leftProjection.filingId.localeCompare(rightProjection.filingId);
}

export function subtractDecimal(current: string, prior: string): string {
  const left = parseDecimal(current);
  const right = parseDecimal(prior);
  const scale = Math.max(left.scale, right.scale);
  const value = left.coefficient * 10n ** BigInt(scale - left.scale) - right.coefficient * 10n ** BigInt(scale - right.scale);
  return formatDecimal(value, scale);
}

export function deriveStandaloneQuarter(input: { periodEnd: string; currentCumulative: string; previousCumulative?: string }): string {
  const suffix = input.periodEnd.slice(5, 10);
  if (suffix === "03-31") return canonicalDecimal(input.currentCumulative);
  if (suffix !== "06-30" && suffix !== "09-30" && suffix !== "12-31") throw new Error("UNSUPPORTED_REPORTING_PERIOD");
  if (input.previousCumulative === undefined) throw new Error("COMPARABLE_PERIOD_MISSING");
  return subtractDecimal(input.currentCumulative, input.previousCumulative);
}

export function financialRatioChange(current: string, prior: string): string | null {
  const left = parseDecimal(current);
  const right = parseDecimal(prior);
  if (right.coefficient <= 0n) return null;
  const scale = Math.max(left.scale, right.scale);
  const currentScaled = left.coefficient * 10n ** BigInt(scale - left.scale);
  const priorScaled = right.coefficient * 10n ** BigInt(scale - right.scale);
  const numerator = (currentScaled - priorScaled) * 10n ** 12n;
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  let quotient = absolute / priorScaled;
  const remainder = absolute % priorScaled;
  if (remainder * 2n >= priorScaled) quotient += 1n;
  return formatDecimal(negative ? -quotient : quotient, 12);
}

function rows(payload: unknown): Record<string, unknown>[] {
  const root = payload as { success?: unknown; result?: { data?: unknown } | null };
  if (root?.success !== true || !root.result || !Array.isArray(root.result.data)) throw new Error("invalid eastmoney response");
  return root.result.data.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid eastmoney row");
    return row as Record<string, unknown>;
  });
}

function reportingPeriod(reportDate: string): FinancialStatementProjection["reportPeriod"] {
  const year = reportDate.slice(0, 4);
  const suffix = reportDate.slice(5);
  if (suffix === "03-31") return { start: `${year}-01-01T00:00:00.000Z`, end: `${reportDate}T00:00:00.000Z`, basis: "quarter" };
  if (suffix === "06-30" || suffix === "09-30") return { start: `${year}-01-01T00:00:00.000Z`, end: `${reportDate}T00:00:00.000Z`, basis: "year_to_date" };
  if (suffix === "12-31") return { start: `${year}-01-01T00:00:00.000Z`, end: `${reportDate}T00:00:00.000Z`, basis: "fiscal_year" };
  throw new Error("unsupported report period");
}

function filingPeriod(title: string): { end: string; type: OfficialFilingProjection["reportType"] } | null {
  const match = /(20\d{2})年(?:第?([一三1-3])季度|半年度|年度)报告/.exec(title);
  if (!match) return null;
  const year = match[1];
  if (title.includes("半年度")) return { end: `${year}-06-30T00:00:00.000Z`, type: "semiannual" };
  if (title.includes("一季度") || title.includes("1季度")) return { end: `${year}-03-31T00:00:00.000Z`, type: "quarterly" };
  if (title.includes("三季度") || title.includes("3季度")) return { end: `${year}-09-30T00:00:00.000Z`, type: "quarterly" };
  return { end: `${year}-12-31T00:00:00.000Z`, type: "annual" };
}

function parseDecimal(value: string): { coefficient: bigint; scale: number } {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error("INVALID_FINANCIAL_DECIMAL");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  return { coefficient: BigInt(`${negative ? "-" : ""}${whole}${fraction}`), scale: fraction.length };
}

function formatDecimal(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
  const whole = scale ? digits.slice(0, -scale) : digits;
  const fraction = scale ? digits.slice(-scale).replace(/0+$/, "") : "";
  const normalized = fraction ? `${whole}.${fraction}` : whole;
  return `${negative && normalized !== "0" ? "-" : ""}${normalized}`;
}

function canonicalDecimal(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error("unsafe financial number");
    return formatDecimalString(String(value));
  }
  if (typeof value !== "string") throw new Error("invalid financial number");
  return formatDecimalString(value);
}

function formatDecimalString(value: string): string {
  const parsed = parseDecimal(value.trim());
  return formatDecimal(parsed.coefficient, parsed.scale);
}

function requiredDate(value: unknown): string {
  if (typeof value !== "string") throw new Error("date missing");
  const date = value.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00.000Z`))) throw new Error("invalid date");
  return date;
}

function requiredText(value: unknown): string {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) throw new Error("text missing");
  return String(value).trim();
}

function chinaMidnight(date: string): string { return new Date(`${date}T00:00:00+08:00`).toISOString(); }
function epochIso(value: unknown): string {
  const timestamp = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(timestamp)) throw new Error("invalid epoch");
  return new Date(timestamp).toISOString();
}
function stripHtml(value: string): string { return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(); }
function chinaDate(value: string): string { return new Date(value).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" }); }
function instrumentCode(instrumentId: string): { symbol: string; exchange: "SSE" | "SZSE"; secuCode: string } {
  const match = /^(SSE|SZSE):(\d{6})$/.exec(instrumentId);
  if (!match) throw new FinancialStatementProviderError("FINANCIAL_STATEMENT_INTEGRITY_FAILURE");
  return { exchange: match[1] as "SSE" | "SZSE", symbol: match[2], secuCode: `${match[2]}.${match[1] === "SSE" ? "SH" : "SZ"}` };
}
