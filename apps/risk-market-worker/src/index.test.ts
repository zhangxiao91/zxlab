import assert from "node:assert/strict";
import test from "node:test";
import { instrumentToTencent, parseTencentDailyBars, parseTencentMinuteBars, parseTencentQuote } from "./index.ts";

test("maps normalized instruments", () => { assert.equal(instrumentToTencent("SSE:512480"), "sh512480"); assert.equal(instrumentToTencent("SZSE:159995"), "sz159995"); });
test("parses quote without coercing empty values to zero", () => { const fields = Array(38).fill(""); fields[3] = "0.899"; fields[4] = "0.906"; fields[5] = "0.904"; fields[6] = "812"; fields[30] = "20260718143205"; fields[33] = "0.910"; fields[34] = "0.892"; const quote = parseTencentQuote("SSE:512480", `v_sh512480="${fields.join("~")}";`, "2026-07-18T06:32:11.000Z"); assert.equal(quote.price, .899); assert.equal(quote.turnover, null); assert.equal(quote.stale, false); });
test("parses daily and minute bars", () => { assert.equal(parseTencentDailyBars("SSE:512480", "sh512480", { data: { sh512480: { day: [["2026-07-18", "1", "2", "3", "0.5", "10"]] } } })[0].close, 2); assert.equal(parseTencentMinuteBars("SSE:512480", "sh512480", { data: { sh512480: { data: { date: "20260718", data: ["0930 0.899 10 9"] } } } })[0].open, null); });
