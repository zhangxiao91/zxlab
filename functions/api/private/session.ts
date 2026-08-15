import { RiskReviewError, verifyCloudflareAccess, type RiskReviewEnv } from "../../_lib/risk/review.ts";

interface FunctionContext { request: Request; env: RiskReviewEnv }
interface PrivateSessionDependencies { verifyAccess?: typeof verifyCloudflareAccess }
interface PrivateSessionTarget { label: string; probe: string }

const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "private, no-store",
  "Content-Security-Policy": "default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

function safeReturnTo(request: Request): string {
  const url = new URL(request.url);
  const raw = url.searchParams.get("returnTo") ?? "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  const destination = new URL(raw, url.origin);
  return destination.origin === url.origin
    ? `${destination.pathname}${destination.search}${destination.hash}`
    : "/";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character]!);
}

function scriptValue(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function sessionTarget(request: Request): PrivateSessionTarget {
  return new URL(request.url).searchParams.get("service") === "market-agent"
    ? { label: "Market Agent", probe: "/api/private/market-agent/profile" }
    : { label: "Signal", probe: "/api/signal/api/watches" };
}

function document(returnTo: string, verified: boolean, target: PrivateSessionTarget): string {
  const title = verified ? "统一授权已完成" : "统一授权暂时无法确认";
  const copy = verified ? `正在确认 ${target.label} 私有会话。` : "请返回原页面后重新打开授权窗口。";
  const script = verified ? `<script>
    const message = { type: "zxlab:private-access-ready" };
    const confirmPrivateSession = async () => {
      const status = document.querySelector("[data-private-access-status]");
      try {
        const response = await fetch(${scriptValue(target.probe)}, {
          credentials: "include",
          redirect: "manual",
        });
        if (response.status !== 200 || response.type === "opaqueredirect") {
          throw new Error("Private session is not ready");
        }
        if (typeof BroadcastChannel === "function") {
          const channel = new BroadcastChannel("zxlab-private-access");
          channel.postMessage(message);
          channel.close();
        }
        if (window.opener && !window.opener.closed) {
          try { window.opener.postMessage(message, window.location.origin); } catch {}
        }
        window.close();
        window.setTimeout(() => window.location.replace(${scriptValue(returnTo)}), 350);
      } catch {
        if (status) {
          status.dataset.state = "waiting";
          status.textContent = "Access 登录已完成，但 ${target.label} 私有会话尚未可用。请保留此窗口并重新载入。";
        }
      }
    };
    void confirmPrivateSession();
  </script>` : "";
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title} | zxlab</title>
    <style>
      :root { color-scheme: light; font-family: Geist, system-ui, sans-serif; background: #f4f2ea; color: #1d1f19; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; }
      main { width: min(34rem, calc(100vw - 3rem)); }
      p { margin: 0 0 1rem; color: #64665e; font-size: .95rem; line-height: 1.7; }
      h1 { max-width: 14ch; margin: 0 0 1.25rem; font-size: clamp(2.25rem, 8vw, 4.5rem); line-height: .98; letter-spacing: 0; }
      a { display: inline-flex; align-items: center; min-height: 2.75rem; padding: 0 1rem; background: #1d1f19; color: #f4f2ea; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <p>ZXLab Private Access</p>
      <h1>${title}</h1>
      <p data-private-access-status>${copy}</p>
      <a href="${escapeHtml(returnTo)}">返回 ZXLab</a>
    </main>
    ${script}
  </body>
</html>`;
}

export async function completePrivateAccess(
  context: FunctionContext,
  dependencies: PrivateSessionDependencies = {},
): Promise<Response> {
  const returnTo = safeReturnTo(context.request);
  const target = sessionTarget(context.request);
  try {
    await (dependencies.verifyAccess ?? verifyCloudflareAccess)(context.request, context.env);
    return new Response(document(returnTo, true, target), { status: 200, headers });
  } catch (cause) {
    const error = cause instanceof RiskReviewError
      ? cause
      : new RiskReviewError("ACCESS_UNAVAILABLE", "Cloudflare Access 暂时无法校验。", 503, { cause });
    return new Response(document(returnTo, false, target), { status: error.status, headers });
  }
}

export const onRequestGet = (context: FunctionContext) => completePrivateAccess(context);
