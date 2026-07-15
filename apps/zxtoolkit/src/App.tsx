import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { gsap } from "gsap";
import {
  ArrowLeft, Check, Download, FileIcon, ImageIcon, LoaderCircle, MoreHorizontal,
  Plus, RefreshCw, Send, Share2, ShieldCheck, Smartphone, Trash2, Upload, Wifi
} from "lucide-react";
import { ApiError, claimTransfer, createSession, deleteTransfer, fetchTransfer, friendlyUploadError, inspectSession, sessionSocket, uploadImage } from "./lib/api";
import { getStoredFile, listTransfers, putTransfer } from "./lib/db";
import { downloadFile, formatBytes, shareFile, validateFiles } from "./lib/files";
import { clearSession, loadSession, parseReceiverSession, receiverUrl, saveSession } from "./lib/session";
import type { LocalTransfer, RemoteTransfer, StoredFile, TransferSession } from "./types";

type ConnectionState = "connecting" | "connected" | "disconnected" | "expired";
type SendStatus = "ready" | "uploading" | "sent" | "failed";

const deviceName = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "ZX 的 Mac" : "这台设备";
const publicAppUrl = import.meta.env.VITE_ZXTOOLKIT_PUBLIC_URL || import.meta.env.VITE_PUBLIC_APP_URL || window.location.origin;

export default function App() {
  const receiverSession = useMemo(() => parseReceiverSession(window.location), []);
  const [mode] = useState<"sender" | "receiver">(receiverSession ? "receiver" : "sender");
  const [session, setSession] = useState<TransferSession | null>(receiverSession);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [peerOnline, setPeerOnline] = useState(false);
  const [selected, setSelected] = useState<StoredFile | null>(null);
  const [remote, setRemote] = useState<RemoteTransfer | null>(null);
  const [receivedBlob, setReceivedBlob] = useState<Blob | null>(null);
  const [history, setHistory] = useState<LocalTransfer[]>([]);
  const [progress, setProgress] = useState(0);
  const [sendStatus, setSendStatus] = useState<SendStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [now, setNow] = useState(Date.now());
  const inputRef = useRef<HTMLInputElement>(null);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 3200);
  }, []);

  useEffect(() => {
    void listTransfers().then(setHistory);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (mode !== "sender") return;
    const restored = loadSession();
    const establish = async () => {
      try {
        if (restored) {
          await inspectSession(restored);
          setSession(restored);
          return;
        }
        const created = await createSession();
        saveSession(created);
        setSession(created);
      } catch (cause) {
        clearSession();
        setConnection("disconnected");
        setError(messageFor(cause, "无法创建传输会话，请确认本地 Worker 已启动"));
      }
    };
    void establish();
  }, [mode]);

  useEffect(() => {
    if (!session) return;
    if (session.expiresAt <= Date.now()) {
      setConnection("expired");
      return;
    }
    const stop = sessionSocket(session, mode, {
      onState: (state) => setConnection(state),
      onMessage: (message) => {
        if (message.type === "connected") {
          setPeerOnline(message.peerOnline);
          if (mode === "receiver" && message.transfer) void receive(message.transfer);
        } else if (message.type === "peer_status") {
          if ((mode === "sender" && message.role === "receiver") || (mode === "receiver" && message.role === "sender")) setPeerOnline(message.online);
        } else if (message.type === "transfer_ready" && mode === "receiver") {
          void receive(message.transfer);
        } else if (message.type === "transfer_claimed" && mode === "sender") {
          setSendStatus("sent");
          flash("手机已收到图片");
        } else if (message.type === "transfer_deleted") {
          if (mode === "receiver") { setRemote(null); setReceivedBlob(null); }
        } else if (message.type === "session_expired") {
          setConnection("expired");
          setError("会话已过期，请在电脑端创建新会话");
          clearSession();
        } else if (message.type === "error") setError(message.message);
      }
    });
    return stop;

    async function receive(transfer: RemoteTransfer) {
      if (!session) return;
      setRemote(transfer);
      setError(null);
      try {
        const blob = await fetchTransfer(session, transfer.id);
        setReceivedBlob(blob);
        await claimTransfer(session, transfer.id);
        flash("图片已收到，并已从临时存储删除");
      } catch (cause) {
        setError(messageFor(cause, "图片接收失败，请让发送端重试"));
      }
    }
  }, [session, mode, flash]);

  useEffect(() => {
    if (!session || mode !== "sender") return;
    const url = receiverUrl(session, publicAppUrl);
    void QRCode.toDataURL(url, { width: 220, margin: 1, color: { dark: "#171714", light: "#f8f7f2" }, errorCorrectionLevel: "M" }).then(setQrCode);
  }, [session, mode]);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (mode !== "sender") return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length) {
        event.preventDefault();
        void acceptFiles(files);
      } else if (event.clipboardData) setError("剪贴板中没有可发送的图片");
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [mode]);

  useEffect(() => {
    const elements = document.querySelectorAll("[data-enter]");
    gsap.fromTo(elements, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.55, stagger: 0.06, ease: "power3.out" });
  }, [mode]);

  async function acceptFiles(files: File[]) {
    const validation = validateFiles(files);
    if (validation) { setError(validation); return; }
    const file = files[0];
    const stored: StoredFile = {
      id: crypto.randomUUID(), fileName: file.name || `粘贴的图片-${Date.now()}.png`, mimeType: file.type,
      size: file.size, createdAt: Date.now(), status: "ready", blob: file
    };
    setSelected(stored); setError(null); setSendStatus("ready"); setProgress(0);
    await putTransfer(stored);
    flash("图片已读取，可以发送");
  }

  async function send() {
    if (!session || !selected || sendStatus === "uploading") return;
    if (session.expiresAt <= Date.now()) { setError("会话已过期，请创建新会话"); return; }
    if (!peerOnline) { setError("手机尚未连接，请先扫描二维码并保持接收页面打开"); return; }
    setSendStatus("uploading"); setProgress(0); setError(null);
    const file = new File([selected.blob], selected.fileName, { type: selected.mimeType });
    try {
      await uploadImage(session, file, setProgress).promise;
      setSendStatus("sent"); setProgress(100);
      await putTransfer({ ...selected, status: "sent" });
      setHistory(await listTransfers());
      flash("上传完成，正在等待手机确认");
    } catch (cause) {
      setSendStatus("failed");
      setError(friendlyUploadError(cause));
    }
  }

  async function replaceSession() {
    clearSession(); setSession(null); setQrCode(null); setPeerOnline(false); setError(null);
    try { const created = await createSession(); saveSession(created); setSession(created); } catch (cause) { setError(messageFor(cause, "无法创建新会话")); }
  }

  async function handleShare() {
    if (!remote || !receivedBlob) return;
    try {
      const result = await shareFile(receivedBlob, remote.fileName);
      flash(result === "shared" ? "已打开系统分享面板" : "此浏览器不支持文件分享，图片已下载，请保存后再分享到微信");
    } catch (cause) {
      if ((cause as DOMException).name !== "AbortError") setError("无法打开分享面板，请使用下载按钮保存图片");
    }
  }

  async function removeReceived() {
    if (!session || !remote) return;
    try { await deleteTransfer(session, remote.id); } catch { /* claimed files may already be absent from R2 */ }
    setRemote(null); setReceivedBlob(null); flash("图片已从当前页面移除");
  }

  const previewUrl = useObjectUrl(selected?.blob ?? null);
  const receivedUrl = useObjectUrl(receivedBlob);
  const remaining = Math.max(0, Math.ceil(((session?.expiresAt ?? now) - now) / 1000));

  return (
    <main className="app-shell overflow-x-hidden w-full max-w-full">
      <header className="nav" data-enter>
        <a className="back-link" href="https://zx-dx.xyz/lab"><ArrowLeft size={15} /> zxlab</a>
        <span className="brand"><span className="brand-mark">z</span><span>zxtoolkit</span></span>
        <button className="icon-button" aria-label="更多设置"><MoreHorizontal size={20} /></button>
      </header>

      {mode === "sender" ? (
        <Sender
          session={session} qrCode={qrCode} remaining={remaining} connection={connection} peerOnline={peerOnline}
          selected={selected} previewUrl={previewUrl} dragging={dragging} progress={progress} status={sendStatus}
          error={error} history={history} inputRef={inputRef} onDrag={setDragging} onFiles={(files) => void acceptFiles(files)}
          onSend={() => void send()} onNewSession={() => void replaceSession()} onOpenHistory={(item) => void getStoredFile(item.id).then((file) => file && setSelected(file))}
        />
      ) : (
        <Receiver session={session} remaining={remaining} connection={connection} peerOnline={peerOnline} remote={remote} previewUrl={receivedUrl}
          error={error} onShare={() => void handleShare()} onDownload={() => remote && receivedBlob && downloadFile(receivedBlob, remote.fileName)} onDelete={() => void removeReceived()} />
      )}

      {notice && <div className="toast"><Check size={16} />{notice}</div>}
      <input ref={inputRef} className="sr-only" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => void acceptFiles(Array.from(event.target.files ?? []))} />
    </main>
  );
}

interface SenderProps {
  session: TransferSession | null; qrCode: string | null; remaining: number; connection: ConnectionState; peerOnline: boolean;
  selected: StoredFile | null; previewUrl: string | null; dragging: boolean; progress: number; status: SendStatus; error: string | null;
  history: LocalTransfer[]; inputRef: React.RefObject<HTMLInputElement | null>; onDrag: (value: boolean) => void; onFiles: (files: File[]) => void;
  onSend: () => void; onNewSession: () => void; onOpenHistory: (item: LocalTransfer) => void;
}

function Sender(props: SenderProps) {
  return <>
    <section className="hero session-hero" data-enter>
      <div className="hero-copy">
        <p className="eyebrow"><span className={`status-dot ${props.peerOnline ? "" : "is-idle"}`} /> {props.peerOnline ? "手机已连接" : connectionCopy(props.connection)}</p>
        <h1>把刚截的图，<br />送到另一台设备。</h1>
        <p className="lede">手机扫描右侧二维码，连接后粘贴截图。会话结束或图片领取后，临时文件自动删除。</p>
        <div className="session-inline"><span>{formatCountdown(props.remaining)}</span><button onClick={props.onNewSession}><RefreshCw size={14} /> 新会话</button></div>
      </div>
      <div className="send-panel">
        <aside className="qr-card">
          <div className="qr-frame">{props.qrCode ? <img src={props.qrCode} alt="手机接收会话二维码" /> : <LoaderCircle className="spin" size={28} />}</div>
          <strong>{props.peerOnline ? "接收端已就绪" : "用手机扫码接收"}</strong>
          <span>二维码 {formatCountdown(props.remaining)} 后失效</span>
        </aside>
        <div className={`drop-zone compact ${props.dragging ? "is-dragging" : ""} ${props.selected ? "has-file" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); props.onDrag(true); }} onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => props.onDrag(false)} onDrop={(event) => { event.preventDefault(); props.onDrag(false); props.onFiles(Array.from(event.dataTransfer.files)); }}>
          {props.selected ? <div className="file-preview compact-preview">
            <div className="preview-media">{props.previewUrl ? <img src={props.previewUrl} alt={props.selected.fileName} /> : <FileIcon size={40} />}</div>
            <div className="file-detail"><p className="file-name">{props.selected.fileName}</p><p>{formatBytes(props.selected.size)} · {props.selected.mimeType}</p>
              {props.status === "uploading" && <div className="progress"><span style={{ width: `${props.progress}%` }} /></div>}
              <button className="send-button" onClick={props.onSend} disabled={props.status === "uploading" || !props.peerOnline}>
                {props.status === "uploading" ? <><LoaderCircle className="spin" size={18} /> 上传中 {props.progress}%</> : props.status === "failed" ? <><RefreshCw size={18} /> 重试发送</> : props.status === "sent" ? <><Check size={18} /> 已发送</> : <><Send size={18} /> 发送到手机</>}
              </button>
            </div>
          </div> : <button className="drop-prompt compact-prompt" onClick={() => props.inputRef.current?.click()}><span className="upload-orbit"><Upload size={25} /></span><strong>粘贴截图，或拖到这里</strong><span><kbd>⌘</kbd><kbd>V</kbd> 直接粘贴，也可点击选择图片</span></button>}
        </div>
      </div>
      {props.error && <p className="page-error">{props.error}</p>}
    </section>
    <section className="transfer-grid grid-flow-dense" data-enter>
      <article className="device-card primary-card"><div className="card-top"><span>当前临时会话</span><button aria-label="创建新会话" onClick={props.onNewSession}><Plus size={18} /></button></div><div className="device-visual"><Smartphone size={42} strokeWidth={1.3} /></div><div><h2>{props.peerOnline ? "手机已连接" : "等待扫码"}</h2><p><span className={`status-dot ${props.peerOnline ? "" : "is-idle"}`} /> {connectionCopy(props.connection)}</p></div></article>
      <article className="info-card"><ShieldCheck size={25} /><h2>短期访问控制</h2><p>高强度随机 token，仅在本次 10 分钟会话有效。</p></article>
      <article className="info-card"><Wifi size={25} /><h2>领取即删除</h2><p>手机收到图片后，R2 临时对象立即删除。</p></article>
    </section>
    <section className="recent"><div className="section-heading"><h2>最近传输</h2><p>记录仅保存在这台设备</p></div><div className="history-list">{props.history.length ? props.history.map((item) => <button key={item.id} onClick={() => props.onOpenHistory(item)} className="history-item"><span className="history-icon"><ImageIcon size={19} /></span><span className="history-name"><strong>{item.fileName}</strong><small>{formatBytes(item.size)} · {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></span><span className="history-status"><Check size={15} /> 已发送</span></button>) : <div className="empty-history">发送后的图片会出现在这里</div>}</div></section>
    <footer><span>zxtoolkit by zxlab</span><span>短期会话 · 领取即删</span><span>{deviceName}</span></footer>
  </>;
}

function Receiver({ session, remaining, connection, peerOnline, remote, previewUrl, error, onShare, onDownload, onDelete }: { session: TransferSession | null; remaining: number; connection: ConnectionState; peerOnline: boolean; remote: RemoteTransfer | null; previewUrl: string | null; error: string | null; onShare: () => void; onDownload: () => void; onDelete: () => void }) {
  return <section className="receive-page" data-enter>
    <div className="receive-copy"><p className="eyebrow"><span className={`status-dot ${connection === "connected" ? "" : "is-idle"}`} /> {connectionCopy(connection)}</p><h1>{remote ? "图片已安全抵达。" : "正在等待图片。"}</h1><p>{peerOnline ? "电脑端已连接" : "请保持此页面打开"} · 剩余 {formatCountdown(remaining)}</p></div>
    <div className={`receive-preview ${!previewUrl ? "is-waiting" : ""}`}>{previewUrl && remote ? <img src={previewUrl} alt={remote.fileName} /> : <div className="waiting-visual"><Smartphone size={54} /><span className="waiting-pulse" /><strong>{session ? "等待电脑发送" : "会话链接无效"}</strong></div>}</div>
    {remote && <div className="receive-meta"><span><strong>{remote.fileName}</strong><small>{formatBytes(remote.size)} · 来自电脑端</small></span><span className="secure-copy"><ShieldCheck size={16} /> 已从临时存储删除</span></div>}
    {error && <p className="receive-error">{error}</p>}
    <div className="receive-actions"><button className="share-button" onClick={onShare} disabled={!previewUrl}><Share2 size={20} /> 分享到其他应用</button><button className="secondary-button" onClick={onDownload} disabled={!previewUrl}><Download size={19} /> 下载图片</button><button className="secondary-button danger" onClick={onDelete} disabled={!remote}><Trash2 size={19} /> 删除</button></div>
    <p className="share-note">分享目标由手机系统和已安装的应用决定；不支持文件分享时请先下载，再分享到微信。</p>
  </section>;
}

function useObjectUrl(blob: Blob | null): string | null {
  const url = useMemo(() => blob ? URL.createObjectURL(blob) : null, [blob]);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return url;
}

function formatCountdown(seconds: number): string { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function connectionCopy(state: ConnectionState): string { return state === "connected" ? "会话已连接" : state === "connecting" ? "正在连接" : state === "expired" ? "会话已过期" : "连接已断开，正在重试"; }
function messageFor(cause: unknown, fallback: string): string { return cause instanceof ApiError || cause instanceof Error ? cause.message : fallback; }
