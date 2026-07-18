import { useEffect, useRef, useState } from "react";

const SCRIPT_ID = "cloudflare-turnstile-script";
const TEST_SITE_KEY = "1x00000000000000000000AA";
const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY || (import.meta.env.DEV ? TEST_SITE_KEY : "");

interface TurnstileApi {
  render: (container: HTMLElement, options: {
    sitekey: string;
    action: string;
    size: "compact";
    callback: (token: string) => void;
    "expired-callback": () => void;
    "error-callback": () => void;
  }) => string;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window { turnstile?: TurnstileApi }
}

export function TurnstileWidget({ onVerify, onError }: { onVerify: (token: string) => void; onError: (message: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onVerify, onError });
  const [loading, setLoading] = useState(true);
  callbacks.current = { onVerify, onError };

  useEffect(() => {
    if (!siteKey) {
      setLoading(false);
      callbacks.current.onError("生产环境尚未配置 Turnstile sitekey");
      return;
    }
    let cancelled = false;
    let widgetId: string | null = null;

    const render = () => {
      if (cancelled || !containerRef.current || !window.turnstile) return;
      widgetId = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        action: "turnstile-spin-v1",
        size: "compact",
        callback: (token) => callbacks.current.onVerify(token),
        "expired-callback": () => callbacks.current.onError("安全验证已过期，请重新验证"),
        "error-callback": () => callbacks.current.onError("安全验证加载失败，请刷新后重试")
      });
      setLoading(false);
    };

    if (window.turnstile) render();
    else {
      let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
      if (!script) {
        script = document.createElement("script");
        script.id = SCRIPT_ID;
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
      }
      script.addEventListener("load", render, { once: true });
      script.addEventListener("error", () => callbacks.current.onError("安全验证脚本加载失败"), { once: true });
    }

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, []);

  return <div className="turnstile-gate" data-action="turnstile-spin-v1">
    {loading && <span>正在加载安全验证…</span>}
    <div ref={containerRef} />
  </div>;
}
