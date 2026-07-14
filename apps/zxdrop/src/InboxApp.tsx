import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Check, Copy, ExternalLink, Inbox, LoaderCircle, RefreshCw, Smartphone } from "lucide-react";
import type { DeviceCredential, DropItem } from "../shared/types";
import { getInbox, loadWebCredential, markDropOpened } from "./lib/device-api";

export default function InboxApp() {
  const [credential] = useState<DeviceCredential | null>(() => loadWebCredential());
  const [items, setItems] = useState<DropItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!credential) { setLoading(false); return; }
    try { setItems(await getInbox(credential)); setError(null); } catch (cause) { setError(cause instanceof Error ? cause.message : "收件箱刷新失败"); }
    finally { setLoading(false); }
  }, [credential]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh]);

  async function copy(item: DropItem) {
    if (item.payload.type !== "text") return;
    try { await navigator.clipboard.writeText(item.payload.text); setCopiedId(item.id); window.setTimeout(() => setCopiedId(null), 1600); }
    catch { setError("浏览器未允许复制，请长按文字手动复制"); }
  }

  async function open(item: DropItem) {
    if (item.payload.type !== "url" || !credential) return;
    await markDropOpened(credential, item.id).catch(() => undefined);
    window.open(item.payload.url, "_blank", "noopener,noreferrer");
  }

  return <main className="utility-page inbox-page">
    <header className="utility-nav"><a href="/"><ArrowLeft size={16} /> zxdrop</a><span className="inbox-device"><Smartphone size={15} /> {credential?.device.name ?? "未配对设备"}</span></header>
    <section className="inbox-heading"><div><p className="utility-kicker"><span className="status-dot" /> 每 3 秒自动刷新</p><h1>收件箱</h1><p>来自已绑定 Mac 的临时文字和链接，24 小时后自动过期。</p></div><button onClick={() => void refresh()} aria-label="刷新收件箱"><RefreshCw size={18} /></button></section>
    {!credential ? <section className="inbox-empty"><Inbox size={38} /><h2>这台设备还没有配对</h2><p>请在 Mac 菜单栏的 zxdrop 中生成二维码并扫描。</p></section> : loading ? <section className="inbox-empty"><LoaderCircle className="spin" size={30} /><p>正在检查新投递</p></section> : items.length === 0 ? <section className="inbox-empty"><Inbox size={38} /><h2>还没有收到内容</h2><p>在 Mac 上复制一段文字或链接，然后点击“发送剪贴板”。</p></section> : <section className="inbox-list">{items.map((item) => <article className="inbox-item" key={item.id}>
      <div className="inbox-meta"><span>{item.senderDeviceName}</span><time>{formatTime(item.createdAt)}</time></div>
      {item.payload.type === "text" ? <p className="inbox-text">{item.payload.text}</p> : <a className="inbox-link" href={item.payload.url} onClick={(event) => { event.preventDefault(); void open(item); }}>{item.payload.title || item.payload.url}<ExternalLink size={16} /></a>}
      <button className="inbox-action" onClick={() => item.payload.type === "text" ? void copy(item) : void open(item)}>{item.payload.type === "text" ? copiedId === item.id ? <><Check size={16} /> 已复制</> : <><Copy size={16} /> 复制文字</> : <><ExternalLink size={16} /> 打开链接</>}</button>
    </article>)}</section>}
    {error && <p className="utility-error floating-error">{error}</p>}
  </main>;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
