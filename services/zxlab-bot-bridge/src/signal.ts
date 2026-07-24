export interface SignalSource {
  title: string;
  url: string;
  publisher?: string;
  publishedAt?: string;
}

export interface SignalItem {
  title: string;
  category: string;
  summary: string;
  whyItMatters?: string;
  suggestedAction?: string;
  importance?: number;
  confidence?: number;
  sources?: SignalSource[];
}

export interface SignalBriefing {
  id: string;
  date: string;
  status: string;
  title: string;
  summary: string;
  generatedAt?: string;
  dataOrigin?: string;
  stats?: { fetched: number; deduplicated: number; selected: number };
  items: SignalItem[];
}

export interface SignalClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetcher?: typeof fetch;
}

export async function fetchLatestSignal(options: SignalClientOptions): Promise<SignalBriefing> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetcher(`${options.baseUrl.replace(/\/$/, "")}/api/briefings/latest`, {
      headers: { accept: "application/json", "user-agent": "zxlab-bot-bridge/0.1" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Signal API returned HTTP ${response.status}`);
    const value: unknown = await response.json();
    if (!isBriefing(value)) throw new Error("Signal API returned an invalid briefing");
    return value;
  } finally {
    clearTimeout(timeout);
  }
}

function isBriefing(value: unknown): value is SignalBriefing {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && typeof item.date === "string" &&
    typeof item.title === "string" && typeof item.summary === "string" &&
    Array.isArray(item.items) && item.items.every(isSignalItem);
}

function isSignalItem(value: unknown): value is SignalItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.title === "string" && typeof item.category === "string" && typeof item.summary === "string";
}
