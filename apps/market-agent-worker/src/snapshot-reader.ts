import { parseMarketSnapshot } from "@zxlab/market-schema";
import type { CurrentMarketSnapshotReader } from "./close-review.ts";

export class MarketSnapshotAdapter implements CurrentMarketSnapshotReader {
  private readonly options: { service?: Fetcher; baseUrl?: string; token?: string; timeoutMs?: number };
  constructor(options: { service?: Fetcher; baseUrl?: string; token?: string; timeoutMs?: number }) { this.options = options; }
  async getCurrentSnapshot(input: Parameters<CurrentMarketSnapshotReader["getCurrentSnapshot"]>[0]) {
    const base = this.options.baseUrl?.trim() || "https://market-api.zx-dx.xyz";
    const url = new URL("/api/market/snapshot", base);
    url.searchParams.set("ids", input.instrumentIds.join(","));
    url.searchParams.set("include", input.include.join(","));
    url.searchParams.set("intervals", input.intervals.join(","));
    url.searchParams.set("quoteMode", input.quoteMode);
    const headers = new Headers({ accept: "application/json" });
    if (this.options.token) headers.set("authorization", `Bearer ${this.options.token}`);
    const timeoutMs = Math.min(60_000, Math.max(1, this.options.timeoutMs ?? 15_000));
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      const request = new Request(url, { headers, signal });
      response = this.options.service ? await this.options.service.fetch(request) : await fetch(request);
    } catch (cause) {
      if (signal.aborted) throw new Error("MARKET_SNAPSHOT_TIMEOUT", { cause });
      throw cause;
    }
    if (!response.ok) throw new Error(`MARKET_SNAPSHOT_HTTP_${response.status}`);
    const payload = await response.json() as { data?: unknown };
    return parseMarketSnapshot(payload.data ?? payload);
  }
}
