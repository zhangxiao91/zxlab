import { statusConfig } from "../config";

export async function requestStatusJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), statusConfig.requestTimeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    if (!statusConfig.apiBaseUrl && typeof window === "undefined") {
      throw new Error("A status API base URL is required outside the browser");
    }
    const url = `${statusConfig.apiBaseUrl}${path}`;
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Status request failed: ${response.status}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
