import { instruments } from "./mock";
import type { BrokerPosition, BrokerSnapshot, HoldingParseDraft, HoldingParsePosition, HoldingParseUnresolvedRow } from "./types";

export type HoldingSourceKind = "csv" | "text";

export class ApiHoldingsParseError extends Error {
  constructor(readonly code: string, message: string, readonly requestId?: string) {
    super(message);
    this.name = "ApiHoldingsParseError";
  }
}

export class ApiHoldingsParseService {
  constructor(private readonly endpoint = "/api/holdings/parse-draft", private readonly fetcher: typeof fetch = fetch) {}
  async parseDraft(input: { text: string; sourceKind: HoldingSourceKind }, options: { signal?: AbortSignal } = {}): Promise<HoldingParseDraft> {
    const response = await this.fetcher.call(globalThis, this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(input),
      credentials: "same-origin",
      signal: options.signal,
    });
    const raw = await response.text();
    let payload: unknown;
    try { payload = JSON.parse(raw) as unknown; }
    catch { throw new ApiHoldingsParseError("INVALID_RESPONSE", "持仓解析服务返回了无法解析的响应。"); }
    const root = object(payload);
    const requestId = typeof root?.requestId === "string" ? root.requestId : undefined;
    if (!response.ok || root?.ok !== true) {
      const error = object(root?.error);
      throw new ApiHoldingsParseError(typeof error?.code === "string" ? error.code : `HTTP_${response.status}`, typeof error?.message === "string" ? error.message : "持仓解析暂不可用。", requestId);
    }
    return normalizeHoldingParseDraft(root.data, { sourceKind: input.sourceKind, requestId });
  }
}

export function normalizeHoldingParseDraft(value: unknown, input: { sourceKind: HoldingSourceKind; fallbackSnapshotAt?: string; provider?: string; model?: string; requestId?: string }): HoldingParseDraft {
  const root = object(value) ?? {};
  const warnings = strings(root.warnings, 40);
  const positions = Array.isArray(root.positions) ? root.positions.flatMap((item) => normalizePosition(item)) : [];
  const unresolvedRows = Array.isArray(root.unresolvedRows) ? root.unresolvedRows.flatMap((item) => normalizeUnresolved(item)) : [];
  if (!positions.length && !unresolvedRows.length) warnings.push("模型未返回可确认持仓；请检查原文或改用 CSV 粘贴。");
  return {
    snapshotAt: validDate(root.snapshotAt) ?? input.fallbackSnapshotAt ?? new Date().toISOString(),
    accountName: text(root.accountName, 120),
    sourceKind: root.sourceKind === "csv" || root.sourceKind === "text" ? root.sourceKind : input.sourceKind,
    positions,
    unresolvedRows,
    warnings,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
  };
}

export function parseLocalHoldingText(text: string, sourceKind: HoldingSourceKind, now = new Date().toISOString()): HoldingParseDraft {
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const positions: HoldingParsePosition[] = [];
  const unresolvedRows: HoldingParseUnresolvedRow[] = [];
  const warnings = ["本草稿由本地表格规则解析；建议再用 LLM 或人工逐项核对。"];
  if (!rows.length) warnings.push("输入为空。");
  const delimiter = rows[0]?.includes("\t") ? "\t" : ",";
  const headers = splitRow(rows[0] ?? "", delimiter).map((item) => item.toLowerCase());
  const hasHeader = headers.some((item) => /代码|证券|symbol|instrument|数量|持仓|成本|cost/.test(item));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  for (const [index, row] of dataRows.entries()) {
    const cells = splitRow(row, delimiter);
    const lookup = (patterns: RegExp[], fallbackIndex: number) => {
      const headerIndex = hasHeader ? headers.findIndex((header) => patterns.some((pattern) => pattern.test(header))) : -1;
      return cells[headerIndex >= 0 ? headerIndex : fallbackIndex]?.trim() ?? "";
    };
    const rawSymbol = lookup([/代码|symbol|instrument/], 0);
    const rawName = lookup([/名称|证券|name/], 1);
    const quantity = parseNumber(lookup([/数量|持仓|股份|份额|quantity/], 2));
    const averageCost = parseNumber(lookup([/成本|均价|cost/], 3));
    const marketValue = parseNumber(lookup([/市值|market/], 4));
    const instrumentId = normalizeInstrumentId(rawSymbol || rawName);
    if (!instrumentId || quantity == null) {
      unresolvedRows.push({ rowNumber: hasHeader ? index + 2 : index + 1, raw: row, reason: !instrumentId ? "无法识别证券代码" : "无法识别持仓数量" });
      continue;
    }
    positions.push({ rawName: rawName || null, rawSymbol: rawSymbol || null, instrumentId, quantity, availableQuantity: null, averageCost, marketValue, unrealizedPnl: null, currency: "CNY", confidence: averageCost == null ? 0.76 : 0.86, warnings: averageCost == null ? ["缺少平均成本"] : [] });
  }
  return { snapshotAt: now, accountName: null, sourceKind, positions, unresolvedRows, warnings };
}

export function brokerSnapshotFromDraft(draft: HoldingParseDraft, importedAt = new Date().toISOString()): BrokerSnapshot {
  const positions: BrokerPosition[] = draft.positions
    .filter((item) => item.instrumentId && item.quantity != null && item.confidence >= 0.55)
    .map((item) => ({ instrumentId: item.instrumentId as string, quantity: item.quantity as number, averageCost: item.averageCost }));
  return {
    id: `broker-snapshot:${hash(`${draft.snapshotAt}|${positions.map((item) => `${item.instrumentId}:${item.quantity}:${item.averageCost ?? ""}`).join("|")}`)}`,
    snapshotAt: draft.snapshotAt,
    accountName: draft.accountName,
    sourceKind: draft.sourceKind,
    importedAt,
    positions,
    rawDraftWarnings: [
      ...draft.warnings,
      ...draft.positions.filter((item) => item.confidence < 0.75 || item.warnings.length).map((item) => `${item.instrumentId ?? item.rawSymbol ?? "未知标的"}: ${item.warnings.join("；") || `低置信度 ${item.confidence.toFixed(2)}`}`),
      ...draft.unresolvedRows.map((item) => `第 ${item.rowNumber ?? "?"} 行未解析：${item.reason}`),
    ],
  };
}

export function normalizeInstrumentId(value: string | null | undefined): string | null {
  if (!value) return null;
  const upper = value.trim().toUpperCase();
  const explicit = /^(SSE|SZSE)[:.]?(\d{6})$/.exec(upper);
  if (explicit) return `${explicit[1]}:${explicit[2]}`;
  const prefixed = /^(SH|SZ)(\d{6})$/.exec(upper);
  if (prefixed) return `${prefixed[1] === "SH" ? "SSE" : "SZSE"}:${prefixed[2]}`;
  const digits = upper.match(/\d{6}/)?.[0];
  if (!digits) return null;
  const known = instruments.find((item) => item.symbol === digits || item.id.endsWith(`:${digits}`));
  if (known) return known.id;
  return /^(5|6|9)/.test(digits) ? `SSE:${digits}` : `SZSE:${digits}`;
}

function normalizePosition(value: unknown): HoldingParsePosition[] {
  const item = object(value);
  if (!item) return [];
  const instrumentId = normalizeInstrumentId(text(item.instrumentId, 32) ?? text(item.rawSymbol, 64));
  const quantity = parseNumber(item.quantity);
  const warnings = strings(item.warnings, 12);
  if (!instrumentId) warnings.push("无法确认交易所前缀");
  if (quantity == null) warnings.push("缺少有效数量");
  const confidence = clamp(parseNumber(item.confidence) ?? (instrumentId && quantity != null ? 0.72 : 0.35), 0, 1);
  return [{
    rawName: text(item.rawName, 120),
    rawSymbol: text(item.rawSymbol, 64),
    instrumentId,
    quantity,
    availableQuantity: parseNumber(item.availableQuantity),
    averageCost: parseNumber(item.averageCost),
    marketValue: parseNumber(item.marketValue),
    unrealizedPnl: parseNumber(item.unrealizedPnl),
    currency: text(item.currency, 12) ?? "CNY",
    confidence,
    warnings,
  }];
}

function normalizeUnresolved(value: unknown): HoldingParseUnresolvedRow[] {
  const item = object(value);
  if (!item) return [];
  const raw = text(item.raw, 2_000);
  const reason = text(item.reason, 300);
  return raw && reason ? [{ rowNumber: parseNumber(item.rowNumber), raw, reason }] : [];
}

function object(value: unknown): Record<string, unknown> | null { return Boolean(value) && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown, max: number): string | null { return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null; }
function strings(value: unknown, maxItems: number): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, maxItems) : []; }
function validDate(value: unknown): string | null { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, value)); }
function parseNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[,，]/g, "").replace(/人民币|元|股|份|CNY/gi, "").trim();
  if (!normalized || normalized === "-") return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
function splitRow(row: string, delimiter: string): string[] {
  if (delimiter === "\t") return row.split("\t");
  return row.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map((item) => item.replace(/^"|"$/g, ""));
}
function hash(input: string): string {
  let value = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) { value ^= input.charCodeAt(index); value = Math.imul(value, 0x01000193); }
  return (value >>> 0).toString(16).padStart(8, "0");
}
