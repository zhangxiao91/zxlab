import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronDown, Copy, Download, ExternalLink, File as FileIcon, ImageIcon, Inbox, LoaderCircle, RefreshCw, Send, Share2, Smartphone, X } from "lucide-react";
import type { DeviceCredential, DropItem } from "../shared/types";
import { ApiError } from "./lib/api";
import { clearWebCredential, fetchDropFile, getInboxPage, loadWebCredential, markDropStatus } from "./lib/device-api";
import { downloadFile, formatBytes, shareFile } from "./lib/files";
import { startInboxRealtime } from "./lib/inbox-realtime";
import { SendPanel } from "./SendPanel";

type ConnectionState = "connecting" | "connected" | "disconnected";

export default function InboxApp() {
  const [credential, setCredential] = useState<DeviceCredential | null>(() => loadWebCredential());
  const [items, setItems] = useState<DropItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [preview, setPreview] = useState<{ item: DropItem; url: string } | null>(null);
  const [mode, setMode] = useState<"inbox" | "send">("inbox");

  const mergeItem = useCallback((item: DropItem) => {
    setItems((current) => [item, ...current.filter((entry) => entry.id !== item.id)].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)));
  }, []);

  const refresh = useCallback(async () => {
    if (!credential) { setLoading(false); return; }
    try {
      const page = await getInboxPage(credential);
      setItems(page.items);
      setError(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        clearWebCredential();
        setCredential(null);
        setItems([]);
        setError("设备凭证已失效，请从 Mac 重新配对");
      } else setError(cause instanceof Error ? cause.message : "收件箱刷新失败");
    } finally { setLoading(false); }
  }, [credential]);

  useEffect(() => {
    if (!credential) { setConnection("disconnected"); return; }
    void refresh();
    const stopRealtime = startInboxRealtime(credential, { onItem: mergeItem, onState: setConnection, onRefresh: () => void refresh() });
    const fallback = window.setInterval(() => void refresh(), 30_000);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => { stopRealtime(); window.clearInterval(fallback); document.removeEventListener("visibilitychange", onVisible); };
  }, [credential, mergeItem, refresh]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 2200);
  }, []);

  async function copy(item: DropItem) {
    const value = item.payload.type === "text" ? item.payload.text : item.payload.type === "url" ? item.payload.url : "";
    if (!value || !credential) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(item.id);
      mergeItem(await markDropStatus(credential, item.id, "claimed"));
      window.setTimeout(() => setCopiedId(null), 1600);
      flash(item.payload.type === "url" ? "链接已复制" : "文字已复制");
    } catch { setError("浏览器未允许复制，请长按内容手动复制"); }
  }

  async function open(item: DropItem) {
    if (item.payload.type !== "url" || !credential) return;
    const url = safeExternalUrl(item.payload.url);
    if (!url) { setError("这个链接使用了不安全的协议，无法打开"); return; }
    window.open(url, "_blank", "noopener,noreferrer");
    try { mergeItem(await markDropStatus(credential, item.id, "claimed")); }
    catch { setError("链接已打开，但领取状态同步失败，稍后会自动重试"); }
  }

  return <main className="utility-page inbox-page overflow-x-hidden w-full max-w-full">
    <header className="utility-nav"><a href="/"><ArrowLeft size={16} /> zxtoolkit</a><span className="inbox-device"><span className={`status-dot ${connection === "connected" ? "" : "is-idle"}`} /><Smartphone size={15} /> {credential?.device.name ?? "未配对设备"}</span></header>
    <section className="inbox-heading"><div><p className="utility-kicker">{connection === "connected" ? "实时连接正常" : connection === "connecting" ? "正在恢复实时连接" : "离线，仍会定时重试"}</p><h1>{mode === "inbox" ? "收件箱" : "发送"}</h1><p>{mode === "inbox" ? "文字、链接、图片和文件默认保留 24 小时，领取后二进制内容立即删除。" : "从手机、iPad 或临时 Web 端投递到任意已配对设备。"}</p></div><button onClick={() => mode === "inbox" ? void refresh() : setMode("inbox")} aria-label={mode === "inbox" ? "刷新收件箱" : "返回收件箱"}>{mode === "inbox" ? <RefreshCw size={18} /> : <Inbox size={18} />}</button></section>
    {credential && <nav className="inbox-mode"><button className={mode === "inbox" ? "is-active" : ""} onClick={() => setMode("inbox")}><Inbox size={16} /> 收件</button><button className={mode === "send" ? "is-active" : ""} onClick={() => setMode("send")}><Send size={16} /> 投递</button></nav>}
    {!credential ? <section className="inbox-empty"><Inbox size={38} /><h2>这台设备还没有配对</h2><p>请在 Mac 菜单栏的 zxtoolkit 中生成二维码并扫描。</p></section> : mode === "send" ? <SendPanel credential={credential} onSent={() => flash("投递完成")} /> : loading ? <section className="inbox-empty"><LoaderCircle className="spin" size={30} /><p>正在检查新投递</p></section> : items.length === 0 ? <section className="inbox-empty"><Inbox size={38} /><h2>还没有收到内容</h2><p>你可以从任意已配对设备向这里投递。</p></section> : <section className="inbox-list">{items.map((item) => <article className={`inbox-item inbox-${item.payload.type}`} key={item.id}>
      <div className="inbox-meta"><span>{item.senderDeviceName}</span><time>{formatTime(item.createdAt)} · {statusText(item)}</time></div>
      {item.payload.type === "text" ? <>
        <p className={`inbox-text ${expanded.has(item.id) ? "is-expanded" : ""}`}>{item.payload.text}</p>
        {item.payload.text.length > 420 && <button className="inbox-expand" onClick={() => setExpanded((current) => toggleSet(current, item.id))}>{expanded.has(item.id) ? "收起" : "展开全文"}<ChevronDown size={14} /></button>}
      </> : item.payload.type === "url" ? <a className="inbox-link" href={safeExternalUrl(item.payload.url) ?? "#"} target="_blank" rel="noopener noreferrer" onClick={(event) => { event.preventDefault(); void open(item); }}>{item.payload.title || readableUrl(item.payload.url)}<ExternalLink size={16} /></a> : <BinaryDropCard credential={credential} item={item} onUpdate={mergeItem} onError={setError} onNotice={flash} onPreview={(url) => setPreview({ item, url })} />}
      {(item.payload.type === "text" || item.payload.type === "url") && <div className="inbox-actions"><button className="inbox-action" onClick={() => void copy(item)}>{copiedId === item.id ? <><Check size={16} /> 已复制</> : <><Copy size={16} /> {item.payload.type === "text" ? "复制文字" : "复制链接"}</>}</button>{item.payload.type === "url" && <button className="inbox-action secondary" onClick={() => void open(item)}><ExternalLink size={16} /> 打开链接</button>}</div>}
    </article>)}</section>}
    {error && <p className="utility-error floating-error">{error}<button onClick={() => { setError(null); void refresh(); }}>重试</button></p>}
    {notice && <div className="toast"><Check size={16} />{notice}</div>}
    {preview && <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={preview.item.payload.type === "image" ? preview.item.payload.fileName : "图片预览"} onClick={() => setPreview(null)}><button className="lightbox-close" onClick={() => setPreview(null)} aria-label="关闭预览"><X size={22} /></button><img src={preview.url} alt={preview.item.payload.type === "image" ? preview.item.payload.fileName : "收到的图片"} /></div>}
  </main>;
}

function BinaryDropCard({ credential, item, onUpdate, onError, onNotice, onPreview }: { credential: DeviceCredential; item: DropItem; onUpdate: (item: DropItem) => void; onError: (message: string) => void; onNotice: (message: string) => void; onPreview: (url: string) => void }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [loading, setLoading] = useState(item.payload.type === "image");
  const [failed, setFailed] = useState(false);
  const url = useMemo(() => blob ? URL.createObjectURL(blob) : null, [blob]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);

  const load = useCallback(async () => {
    if (item.status === "claimed" || item.status === "expired") { setLoading(false); return; }
    setLoading(true); setFailed(false);
    try {
      const received = await fetchDropFile(credential, item.id);
      setBlob(received);
    } catch (cause) { setFailed(true); onError(cause instanceof Error ? cause.message : "文件加载失败"); }
    finally { setLoading(false); }
  }, [credential, item.id, item.status, onError]);
  useEffect(() => {
    if (item.payload.type === "image") void load();
    else setLoading(false);
  }, [item.payload.type, load]);

  if (item.payload.type !== "image" && item.payload.type !== "file") return null;
  const fileName = item.payload.fileName;
  if (item.status === "claimed" || item.status === "expired") return <div className="inbox-image-block is-claimed">
    <div className="image-detail"><span>{item.payload.fileName}</span><small>{formatBytes(item.payload.size)} · 文件已领取并从临时存储删除</small></div>
  </div>;
  async function claim(kind: "share" | "download") {
    setLoading(true);
    setFailed(false);
    try {
      const content = blob ?? await fetchDropFile(credential, item.id);
      if (!blob) setBlob(content);
      if (kind === "share") {
        const result = await shareFile(content, fileName);
        onNotice(result === "shared" ? "已打开系统分享面板" : "浏览器不支持文件分享，文件已下载，请保存后再分享");
      } else {
        downloadFile(content, fileName);
        onNotice("文件已下载");
      }
      onUpdate(await markDropStatus(credential, item.id, "claimed"));
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setFailed(true);
        onError("操作失败，请重试或使用下载按钮");
      }
    } finally { setLoading(false); }
  }

  async function previewImage() {
    if (!url || item.payload.type !== "image") return;
    onPreview(url);
    if (item.status === "delivered") onUpdate(await markDropStatus(credential, item.id, "opened").catch(() => item));
  }

  return <div className="inbox-image-block">
    {item.payload.type === "image" ? <button className="inbox-image-preview" onClick={() => void previewImage()} disabled={!url}>{loading ? <LoaderCircle className="spin" size={28} /> : failed ? <><ImageIcon size={28} /><span>图片加载失败</span></> : url ? <img src={url} alt={item.payload.fileName} /> : null}</button> : <div className="inbox-file-preview">{loading ? <LoaderCircle className="spin" size={28} /> : <FileIcon size={30} />}<span>{failed ? "文件加载失败" : "点击下方操作后加载"}</span></div>}
    <div className="image-detail"><span>{item.payload.fileName}</span><small>{formatBytes(item.payload.size)} · {item.payload.mimeType}</small></div>
    {failed && item.payload.type === "image" ? <button className="inbox-action" onClick={() => void load()}><RefreshCw size={16} /> 重新加载</button> : <div className="inbox-actions"><button className="inbox-action" onClick={() => void claim("share")} disabled={loading}><Share2 size={16} /> 分享</button><button className="inbox-action secondary" onClick={() => void claim("download")} disabled={loading}><Download size={16} /> 下载</button></div>}
  </div>;
}

export function safeExternalUrl(value: string): string | null {
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null; } catch { return null; }
}
function readableUrl(value: string): string { try { const url = new URL(value); return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`; } catch { return value; } }
function toggleSet(current: Set<string>, value: string): Set<string> { const next = new Set(current); if (next.has(value)) next.delete(value); else next.add(value); return next; }
function formatTime(value: string): string { return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }); }
function statusText(item: DropItem): string { return item.status === "claimed" ? "已领取" : item.status === "opened" ? "已查看" : item.status === "expired" ? "已过期" : item.status === "failed" ? "投递失败" : "已送达"; }
