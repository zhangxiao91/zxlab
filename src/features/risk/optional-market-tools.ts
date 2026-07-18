import type { Announcement, IndustryPerformance, ToolResult } from "./types";

export interface OptionalMarketDataTools {
  getAnnouncements(instrumentId: string, start: string, end: string): Promise<ToolResult<Announcement[]>>;
  getIndustryPerformance(instrumentId: string, date: string): Promise<ToolResult<IndustryPerformance>>;
}

export class MockOptionalMarketDataTools implements OptionalMarketDataTools {
  async getAnnouncements(): Promise<ToolResult<Announcement[]>> {
    return { ok: true, data: [], warnings: ["MVP 1.2 尚未接入公告数据源。"], error: null };
  }
  async getIndustryPerformance(instrumentId: string, date: string): Promise<ToolResult<IndustryPerformance>> {
    return { ok: true, data: { instrumentId, date, industry: "待接入", returnPct: null, rank: null }, warnings: ["MVP 1.2 尚未接入行业表现数据源。"], error: null };
  }
}
