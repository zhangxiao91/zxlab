import { useEffect, useMemo, useRef, useState } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Download,
  FileIcon,
  ImageIcon,
  Laptop,
  LoaderCircle,
  MoreHorizontal,
  Plus,
  Send,
  Share2,
  ShieldCheck,
  Smartphone,
  Upload,
  Wifi
} from "lucide-react";
import { getStoredFile, listTransfers, putTransfer } from "./lib/db";
import { formatBytes, shareFile, validateFiles } from "./lib/files";
import type { LocalTransfer, StoredFile, TransferStatus } from "./types";

gsap.registerPlugin(ScrollTrigger);

type View = "send" | "receive";

const deviceName = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "ZX 的 Mac" : "这台设备";

export default function App() {
  const [view, setView] = useState<View>("send");
  const [selected, setSelected] = useState<StoredFile | null>(null);
  const [history, setHistory] = useState<LocalTransfer[]>([]);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<TransferStatus>("ready");
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLElement>(null);

  useEffect(() => {
    void listTransfers().then(setHistory);
  }, []);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (view !== "send") return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length) {
        event.preventDefault();
        void acceptFiles(files);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [view]);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.from("[data-enter]", { opacity: 0, y: 18, duration: 0.7, stagger: 0.08, ease: "power3.out" });
      gsap.fromTo("[data-reveal]", { opacity: 0.15 }, {
        opacity: 1,
        stagger: 0.08,
        scrollTrigger: { trigger: "[data-reveal-wrap]", start: "top 80%", end: "bottom 60%", scrub: 0.6 }
      });
    }, rootRef);
    return () => ctx.revert();
  }, [view]);

  async function acceptFiles(files: File[]) {
    const validationError = validateFiles(files);
    if (validationError) {
      setError(validationError);
      return;
    }
    const file = files[0];
    const transfer: StoredFile = {
      id: crypto.randomUUID(),
      fileName: file.name || `粘贴的图片-${Date.now()}.png`,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      createdAt: Date.now(),
      status: "ready",
      blob: file
    };
    setError(null);
    setProgress(0);
    setStatus("ready");
    setSelected(transfer);
    await putTransfer(transfer);
  }

  async function send() {
    if (!selected || status === "sending") return;
    setStatus("sending");
    setProgress(8);
    for (const value of [21, 43, 68, 86, 100]) {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      setProgress(value);
    }
    const sent = { ...selected, status: "sent" as const };
    await putTransfer(sent);
    setSelected(sent);
    setStatus("sent");
    setHistory(await listTransfers());
    setNotice("已送达 iPhone");
    window.setTimeout(() => setNotice(null), 2400);
  }

  async function openHistory(item: LocalTransfer) {
    const stored = await getStoredFile(item.id);
    if (stored) {
      setSelected(stored);
      setStatus(stored.status);
    }
  }

  const previewUrl = useMemo(() => selected ? URL.createObjectURL(selected.blob) : null, [selected]);
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  async function handleShare() {
    if (!selected) return;
    try {
      const result = await shareFile(selected.blob, selected.fileName);
      setNotice(result === "shared" ? "已打开系统分享面板" : "当前浏览器不支持文件分享，已开始下载");
    } catch (shareError) {
      if ((shareError as DOMException).name !== "AbortError") setError("无法分享这个文件，请尝试下载");
    }
  }

  return (
    <main ref={rootRef} className="app-shell overflow-x-hidden w-full max-w-full">
      <header className="nav" data-enter>
        <a className="back-link" href="/lab"><ArrowLeft size={15} /> zxlab</a>
        <button className="brand" onClick={() => setView("send")} aria-label="回到 zxdrop 首页">
          <span className="brand-mark">z</span><span>zxdrop</span>
        </button>
        <button className="icon-button" aria-label="更多设置"><MoreHorizontal size={20} /></button>
      </header>

      {view === "send" ? (
        <SendView
          selected={selected}
          previewUrl={previewUrl}
          progress={progress}
          status={status}
          error={error}
          dragging={dragging}
          history={history}
          inputRef={inputRef}
          onDrag={setDragging}
          onFiles={(files) => void acceptFiles(files)}
          onSend={() => void send()}
          onOpenHistory={(item) => void openHistory(item)}
          onReceive={() => setView("receive")}
        />
      ) : (
        <ReceiveView selected={selected} previewUrl={previewUrl} onBack={() => setView("send")} onShare={() => void handleShare()} />
      )}

      {notice && <div className="toast"><Check size={16} />{notice}</div>}
      <input ref={inputRef} className="sr-only" type="file" multiple onChange={(event) => void acceptFiles(Array.from(event.target.files ?? []))} />
    </main>
  );
}

interface SendViewProps {
  selected: StoredFile | null;
  previewUrl: string | null;
  progress: number;
  status: TransferStatus;
  error: string | null;
  dragging: boolean;
  history: LocalTransfer[];
  inputRef: React.RefObject<HTMLInputElement | null>;
  onDrag: (value: boolean) => void;
  onFiles: (files: File[]) => void;
  onSend: () => void;
  onOpenHistory: (item: LocalTransfer) => void;
  onReceive: () => void;
}

function SendView(props: SendViewProps) {
  const { selected, previewUrl, progress, status, error, dragging, history, inputRef, onDrag, onFiles, onSend, onOpenHistory, onReceive } = props;
  return (
    <>
      <section className="hero" data-enter>
        <div className="hero-copy">
          <p className="eyebrow"><span className="status-dot" /> 设备已连接</p>
          <h1>把刚截的图，<br />送到另一台设备。</h1>
          <p className="lede">不登录，不绕路。粘贴后，文件只在你的设备之间短暂停留。</p>
        </div>

        <div
          className={`drop-zone ${dragging ? "is-dragging" : ""} ${selected ? "has-file" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); onDrag(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => onDrag(false)}
          onDrop={(event) => { event.preventDefault(); onDrag(false); onFiles(Array.from(event.dataTransfer.files)); }}
        >
          {selected ? (
            <div className="file-preview">
              <div className="preview-media">
                {selected.mimeType.startsWith("image/") && previewUrl ? <img src={previewUrl} alt={selected.fileName} /> : <FileIcon size={44} />}
              </div>
              <div className="file-detail">
                <div><p className="file-name">{selected.fileName}</p><p>{formatBytes(selected.size)} · {selected.mimeType || "文件"}</p></div>
                <div className="receiver-row"><span className="device-icon"><Smartphone size={18} /></span><span><small>发送至</small>iPhone</span><ChevronDown size={16} /></div>
                {status === "sending" && <div className="progress"><span style={{ width: `${progress}%` }} /></div>}
                <button className="send-button" onClick={onSend} disabled={status === "sending" || status === "sent"}>
                  {status === "sending" ? <><LoaderCircle className="spin" size={18} /> 正在加密并发送 {progress}%</> : status === "sent" ? <><Check size={18} /> 已送达</> : <><Send size={18} /> 发送文件</>}
                </button>
                {status === "sent" && <button className="text-button" onClick={onReceive}>在手机接收视图中打开</button>}
              </div>
            </div>
          ) : (
            <button className="drop-prompt" onClick={() => inputRef.current?.click()}>
              <span className="upload-orbit"><Upload size={25} /></span>
              <strong>粘贴截图，或将文件拖到这里</strong>
              <span><kbd>⌘</kbd><kbd>V</kbd> 直接粘贴，也可点击选择文件</span>
            </button>
          )}
          {error && <p className="error-message">{error}</p>}
        </div>
      </section>

      <section className="transfer-grid grid-flow-dense" data-enter>
        <article className="device-card primary-card">
          <div className="card-top"><span>常用设备</span><button aria-label="添加设备"><Plus size={18} /></button></div>
          <div className="device-visual"><Smartphone size={42} strokeWidth={1.3} /><span className="signal"><i /><i /><i /></span></div>
          <div><h2>iPhone</h2><p><span className="status-dot" /> 在线 · 刚刚使用</p></div>
        </article>
        <article className="info-card"><ShieldCheck size={25} /><h2>仅在设备间</h2><p>文件离开浏览器前完成加密，领取后自动销毁。</p></article>
        <article className="info-card"><Wifi size={25} /><h2>10 分钟有效</h2><p>不创建永久链接，不把临时传输变成网盘。</p></article>
      </section>

      <section className="recent" data-reveal-wrap>
        <div className="section-heading"><h2>{"最近传输".split("").map((char, index) => <span data-reveal key={`${char}-${index}`}>{char}</span>)}</h2><p>记录仅保存在这台设备</p></div>
        <div className="history-list">
          {history.length ? history.map((item) => (
            <button key={item.id} onClick={() => onOpenHistory(item)} className="history-item">
              <span className="history-icon">{item.mimeType.startsWith("image/") ? <ImageIcon size={19} /> : <FileIcon size={19} />}</span>
              <span className="history-name"><strong>{item.fileName}</strong><small>{formatBytes(item.size)} · {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small></span>
              <span className="history-status"><Check size={15} /> 已保存</span>
            </button>
          )) : <div className="empty-history">发送后的文件会出现在这里</div>}
        </div>
      </section>

      <footer><span>zxdrop by zxlab</span><span>临时传输，本地优先</span><span>{deviceName}</span></footer>
    </>
  );
}

function ReceiveView({ selected, previewUrl, onBack, onShare }: { selected: StoredFile | null; previewUrl: string | null; onBack: () => void; onShare: () => void }) {
  return (
    <section className="receive-page" data-enter>
      <button className="mobile-back" onClick={onBack}><ArrowLeft size={18} /> 返回</button>
      <div className="receive-copy"><p className="eyebrow"><span className="status-dot" /> 刚刚收到</p><h1>文件已安全抵达。</h1><p>来自 ZX 的 Mac · 10 分钟后自动销毁</p></div>
      <div className="receive-preview">
        {selected && selected.mimeType.startsWith("image/") && previewUrl ? <img src={previewUrl} alt={selected.fileName} /> : <div className="generic-file"><FileIcon size={54} /><strong>{selected?.fileName ?? "还没有收到文件"}</strong></div>}
      </div>
      {selected && <div className="receive-meta"><span><strong>{selected.fileName}</strong><small>{formatBytes(selected.size)}</small></span><span className="secure-copy"><ShieldCheck size={16} /> 已解密</span></div>}
      <div className="receive-actions">
        <button className="share-button" onClick={onShare} disabled={!selected}><Share2 size={20} /> 分享到其他应用</button>
        <button className="secondary-button" onClick={onShare} disabled={!selected}><Download size={19} /> 保存文件</button>
        <button className="secondary-button" disabled={!selected || !selected.mimeType.startsWith("image/")}><Copy size={19} /> 复制图片</button>
      </div>
      <p className="share-note">分享目标由手机系统和已安装的应用决定。</p>
    </section>
  );
}
