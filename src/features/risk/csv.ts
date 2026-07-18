import { stableFingerprint } from "./ledger";
import type { CsvFieldMapping, CsvPreview, Transaction, TransactionType } from "./types";

export const DEFAULT_CSV_MAPPING: CsvFieldMapping = { id: "id", account: "account", instrumentId: "instrument_id", type: "side", side: "side", quantity: "quantity", price: "price", fee: "fee", executedAt: "executed_at" };
const TYPES = new Set<TransactionType>(["BUY", "SELL", "FEE", "TAX", "DIVIDEND", "DEPOSIT", "WITHDRAWAL", "POSITION_ADJUSTMENT"]);

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let row: string[] = [], field = "", quoted = false;
  for (let index = 0; index <= text.length; index += 1) {
    const char = text[index] ?? "\n";
    if (char === '"' && quoted && text[index + 1] === '"') { field += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { row.push(field.trim()); field = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) { if (char === "\r" && text[index + 1] === "\n") index += 1; row.push(field.trim()); field = ""; if (row.some(Boolean)) records.push(row); row = []; }
    else field += char;
  }
  const headers = records.shift() ?? [];
  return { headers, rows: records.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]))) };
}

export function previewCsv(text: string, mapping: CsvFieldMapping = DEFAULT_CSV_MAPPING, existing: Transaction[] = []): CsvPreview {
  const parsed = parseCsv(text);
  const valid: Transaction[] = [], invalid: CsvPreview["invalid"] = [], duplicates: CsvPreview["duplicates"] = [];
  const ids = new Set(existing.map((item) => item.id));
  const fingerprints = new Set(existing.map((item) => item.fingerprint));
  parsed.rows.forEach((raw, index) => {
    const rowNumber = index + 2;
    const type = (raw[mapping.type] || raw[mapping.side] || "").toUpperCase() as TransactionType;
    const sideRaw = (raw[mapping.side] || "").toUpperCase();
    const id = raw[mapping.id]?.trim();
    const account = raw[mapping.account]?.trim();
    const instrumentId = raw[mapping.instrumentId]?.trim() || null;
    const quantity = Number(raw[mapping.quantity] || 0), price = Number(raw[mapping.price] || 0), fee = Number(raw[mapping.fee] || 0);
    const executedAt = raw[mapping.executedAt]?.trim();
    const errors: string[] = [];
    if (!id) errors.push("缺少 id"); if (!account) errors.push("缺少 account"); if (!TYPES.has(type)) errors.push("事件类型不支持");
    if (["BUY", "SELL", "POSITION_ADJUSTMENT"].includes(type) && !instrumentId) errors.push("交易事件缺少 instrument_id");
    if (instrumentId && !/^(SSE|SZSE):\d{6}$/.test(instrumentId)) errors.push("证券代码须为 SSE:xxxxxx 或 SZSE:xxxxxx");
    if (!Number.isFinite(quantity) || quantity < 0) errors.push("quantity 必须为非负数");
    if (!Number.isFinite(price) || price < 0) errors.push("price 必须为非负数");
    if (!Number.isFinite(fee) || fee < 0) errors.push("fee 必须为非负数");
    if (!executedAt || Number.isNaN(Date.parse(executedAt))) errors.push("executed_at 不是有效时间");
    if (errors.length) { invalid.push({ rowNumber, raw, errors }); return; }
    const base = { id, account, instrumentId, type, side: sideRaw === "SELL" ? "SELL" as const : sideRaw === "BUY" ? "BUY" as const : null, quantity, price, fee, executedAt };
    const transaction: Transaction = { ...base, fingerprint: stableFingerprint(base), importedAt: new Date().toISOString() };
    if (ids.has(id) || fingerprints.has(transaction.fingerprint)) { duplicates.push({ rowNumber, id, reason: ids.has(id) ? "id 重复" : "稳定指纹重复" }); return; }
    ids.add(id); fingerprints.add(transaction.fingerprint); valid.push(transaction);
  });
  return { headers: parsed.headers, mapping, valid, invalid, duplicates };
}
