import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import { ArrowLeft, Check, ChevronDown, Clipboard, Copy, Download, ExternalLink, FileUp, Inbox, LoaderCircle, LogOut, Plus, RefreshCw, RotateCw, Settings, Smartphone, Trash2, X } from "lucide-react";
import type { Device, DeviceCredential, DropItem, PairingSessionResponse, PublicStatusResponse } from "../../shared/types";
import { ApiError } from "../../src/lib/api";
import { payloadForFile } from "../../shared/payload";
import { cancelPairingSession, createAddDevicePairingSession, createPairingSession, fetchDropFile, getDevices, getInboxPage, getPairingStatus, getPublicStatus, getRecentDrops, inboxSocket, markDropStatus, removeDevice, renameCurrentDevice, rotateDeviceCredential, sendDrop, uploadDropFile } from "../../src/lib/device-api";
import { createCredentialStore, listenForNotificationActions, listenForScreenshots, notifyDelivery, openExternal, quitApp, readClipboardDrop, registerSendShortcut, resolveDefaultDeviceId, saveReceivedFile, screenshotDrop, writeClipboardText, type ClipboardDrop } from "./platform";

const store = createCredentialStore();
const publicAppUrl = import.meta.env.VITE_ZXTOOLKIT_PUBLIC_URL || import.meta.env.VITE_PUBLIC_APP_URL || "http://localhost:4173";

export default function DesktopApp() {
  const [credential, setCredential] = useState<DeviceCredential | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [targetId, setTargetId] = useState("");
  const [recent, setRecent] = useState<DropItem[]>([]);
  const [pulse, setPulse] = useState<PublicStatusResponse | null>(null);
  const [pairing, setPairing] = useState<PairingSessionResponse | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "reading" | "sending" | "success" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [lastAttempt, setLastAttempt] = useState<ClipboardDrop | null>(null);
  const [connected, setConnected] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deviceName, setDeviceName] = useState("");
  const [inbox, setInbox] = useState<DropItem[]>([]);
  const [screenshotPath, setScreenshotPath] = useState<string | null>(null);
  const [autoCopy, setAutoCopy] = useState(() => localStorage.getItem("zxtoolkit.auto-copy") === "1");
  const fileInput = useRef<HTMLInputElement>(null);
  const sendClipboardRef = useRef<() => void>(() => undefined);

  const refresh = useCallback(async (active: DeviceCredential) => {
    const [deviceResult, recentResult, publicResult] = await Promise.all([getDevices(active), getRecentDrops(active), getPublicStatus().catch(() => null)]);
    setDevices(deviceResult.pairedDevices);
    setRecent(recentResult);
    setPulse(publicResult);
    setConnected(true);
    const storedDefault = await store.loadDefaultDeviceId();
    const next = resolveDefaultDeviceId(deviceResult.pairedDevices, storedDefault);
    setTargetId(next);
    if (next) await store.saveDefaultDeviceId(next);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const saved = await store.loadCredential();
        if (!saved) { await beginPairing(); return; }
      setCredential(saved);
      setDeviceName(saved.device.name);
        try {
          await refresh(saved);
        } catch (cause) {
          if (cause instanceof ApiError && cause.status === 401) {
            await store.clear(); setCredential(null); await beginPairing();
          } else {
            setConnected(false);
            setStatus("error");
            setMessage(cause instanceof Error ? cause.message : "无法连接传输服务，请稍后重试");
          }
        }
      } catch (cause) {
        setStatus("error");
        setMessage(cause instanceof Error ? cause.message : "无法读取本机设备凭证");
      }
    })();
  }, [refresh]);

  useEffect(() => {
    if (!pairing) return;
    void QRCode.toDataURL(pairing.pairUrl, { width: 196, margin: 1, color: { dark: "#171714", light: "#f7f5ef" } }).then(setQrCode);
    const timer = window.setInterval(async () => {
      try {
        const result = await getPairingStatus(pairing.id, pairing.claimToken);
        if (result.status === "confirmed") {
          window.clearInterval(timer);
          if (result.mode === "bootstrap") {
            await store.saveCredential(result.credential);
            await store.saveDefaultDeviceId(result.receiver.id);
            setCredential(result.credential); setDeviceName(result.credential.device.name);
            await refresh(result.credential);
          } else if (credential) {
            await refresh(credential);
            setStatus("success");
            setMessage(`${result.receiver.name} 已添加`);
          }
          setPairing(null); setQrCode(null);
        } else if (result.status === "expired") {
          window.clearInterval(timer); setMessage("配对二维码已过期，请重新生成");
        }
      } catch { /* next poll retries */ }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [credential, pairing, refresh]);

  const refreshInbox = useCallback(async (active: DeviceCredential) => {
    const page = await getInboxPage(active, undefined, 12);
    setInbox(page.items);
  }, []);

  useEffect(() => {
    if (!credential) return;
    void refreshInbox(credential);
    const stop = inboxSocket(credential, {
      onState: (state) => setConnected(state === "connected"),
      onReconnect: () => void refreshInbox(credential),
      onItem: (item) => {
        setInbox((current) => [item, ...current.filter((entry) => entry.id !== item.id)].slice(0, 20));
        void notifyDelivery(`${item.senderDeviceName} 发来${kindLabel(item)}`, item.id);
        if (autoCopy && item.payload.type === "text") void claimText(item);
      }
    });
    const fallback = window.setInterval(() => void refreshInbox(credential), 30_000);
    return () => { stop(); window.clearInterval(fallback); };
  }, [autoCopy, credential, refreshInbox]);

  useEffect(() => {
    if (!credential) return;
    const refreshPulse = () => void getPublicStatus().then(setPulse).catch(() => undefined);
    refreshPulse();
    const timer = window.setInterval(refreshPulse, 30_000);
    return () => window.clearInterval(timer);
  }, [credential]);

  useEffect(() => {
    let dispose: () => void = () => undefined;
    void listenForScreenshots((path) => setScreenshotPath(path)).then((stop) => { dispose = stop; });
    return () => dispose();
  }, []);

  useEffect(() => {
    let dispose: () => void = () => undefined;
    void listenForNotificationActions((dropId) => {
      if (!dropId) return;
      document.getElementById(`desktop-drop-${dropId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }).then((stop) => { dispose = stop; });
    return () => dispose();
  }, []);

  useEffect(() => {
    let dispose: (() => Promise<void>) | undefined;
    void registerSendShortcut(() => sendClipboardRef.current()).then((stop) => { dispose = stop; }).catch(() => {
      setMessage("全局快捷键注册失败，仍可使用菜单栏按钮");
    });
    return () => { void dispose?.(); };
  }, []);

  async function beginPairing() {
    setMessage(null); setQrCode(null);
    try { setPairing(await createPairingSession("我的 Mac")); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "无法创建配对二维码"); }
  }

  async function beginAddDevice() {
    if (!credential) return;
    setMessage(null); setQrCode(null);
    try { setPairing(await createAddDevicePairingSession(credential)); }
    catch (cause) { setStatus("error"); setMessage(cause instanceof Error ? cause.message : "无法创建设备二维码"); }
  }

  async function cancelActivePairing() {
    if (!pairing) return;
    const active = pairing;
    setPairing(null); setQrCode(null);
    await cancelPairingSession(active.id, active.claimToken).catch(() => undefined);
  }

  async function sendClipboard() {
    if (!credential || !targetId || status === "reading" || status === "sending") return;
    setStatus("reading"); setMessage(null);
    try {
      const drop = await readClipboardDrop();
      setLastAttempt(drop);
      await deliver(drop);
    } catch (cause) {
      await handleSendError(cause);
    }
  }
  sendClipboardRef.current = () => void sendClipboard();

  async function deliver(drop: ClipboardDrop) {
    if (!credential || !targetId) return;
    setStatus("sending"); setProgress(0); setMessage(null);
    const created = await sendDrop(credential, targetId, drop.payload);
    const item = (drop.payload.type === "image" || drop.payload.type === "file") && drop.blob
      ? await uploadDropFile(credential, created, drop.blob, setProgress).promise
      : created;
    setRecent((current) => [item, ...current.filter((entry) => entry.id !== item.id)].slice(0, 20));
    setStatus("success"); setProgress(100);
    const deliveredMessage = drop.payload.type === "url" ? "链接已投递" : drop.payload.type === "image" ? "图片已投递" : drop.payload.type === "file" ? "文件已投递" : "文字已投递";
    setMessage(deliveredMessage);
    await notifyDelivery(`${deliveredMessage}到 ${selectedDevice?.name ?? "目标设备"}`).catch(() => undefined);
    window.setTimeout(() => { setStatus("idle"); setMessage(null); setProgress(0); }, 2200);
  }

  async function retryLast() {
    if (!lastAttempt || status === "sending") return;
    try { await deliver(lastAttempt); } catch (cause) { await handleSendError(cause); }
  }

  async function handleSendError(cause: unknown) {
    setConnected(!(cause instanceof ApiError && cause.status === 0));
    if (cause instanceof ApiError && cause.status === 401) {
      await store.clear();
      setCredential(null);
      setDevices([]);
      await beginPairing();
      setMessage("设备凭证已失效，请重新配对");
    } else {
      setMessage(cause instanceof Error ? cause.message : "发送失败，请稍后重试");
    }
    setStatus("error");
  }

  async function removePairedDevice(id: string) {
    if (!credential) return;
    const target = devices.find((device) => device.id === id);
    if (!target || !window.confirm(`解除与“${target.name}”的绑定？解除后该设备凭证会立即失效。`)) return;
    try {
      await removeDevice(credential, id);
      const remaining = devices.filter((device) => device.id !== id);
      setDevices(remaining);
      if (remaining.length) {
        setTargetId(remaining[0].id);
        await store.saveDefaultDeviceId(remaining[0].id);
      } else {
        await store.clear();
        setCredential(null);
        await beginPairing();
      }
    } catch (cause) {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : "解除设备失败，请稍后重试");
    }
  }

  async function saveDeviceName() {
    if (!credential || !deviceName.trim()) return;
    try {
      const device = await renameCurrentDevice(credential, deviceName.trim());
      const updated = { ...credential, device };
      await store.saveCredential(updated);
      setCredential(updated);
      setDeviceName(device.name);
      setStatus("success"); setMessage("Mac 名称已更新");
    } catch (cause) { setStatus("error"); setMessage(cause instanceof Error ? cause.message : "设备名称更新失败"); }
  }

  async function rotateCredential() {
    if (!credential) return;
    try {
      const updated = await rotateDeviceCredential(credential);
      await store.saveCredential(updated);
      setCredential(updated);
      setStatus("success"); setMessage("设备凭证已轮换，旧凭证立即失效");
    } catch (cause) { setStatus("error"); setMessage(cause instanceof Error ? cause.message : "凭证轮换失败"); }
  }

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    const payload = payloadForFile(file);
    if (!payload) { setStatus("error"); setMessage("文件无效或超过 20 MB"); return; }
    const drop: ClipboardDrop = { payload, blob: file };
    setLastAttempt(drop);
    try { await deliver(drop); } catch (cause) { await handleSendError(cause); }
  }

  async function sendScreenshot() {
    if (!screenshotPath) return;
    try {
      const drop = await screenshotDrop(screenshotPath);
      setScreenshotPath(null);
      setLastAttempt(drop);
      await deliver(drop);
    } catch (cause) { await handleSendError(cause); }
  }

  async function claimText(item: DropItem) {
    if (!credential || item.payload.type !== "text") return;
    try {
      await writeClipboardText(item.payload.text);
      const updated = await markDropStatus(credential, item.id, "claimed");
      setInbox((current) => current.map((entry) => entry.id === item.id ? updated : entry));
      setMessage("文字已复制到 Mac 剪贴板");
      setStatus("success");
    } catch (cause) { setStatus("error"); setMessage(cause instanceof Error ? cause.message : "复制失败"); }
  }

  async function claimUrl(item: DropItem) {
    if (!credential || item.payload.type !== "url") return;
    try {
      await openExternal(item.payload.url);
      const updated = await markDropStatus(credential, item.id, "claimed");
      setInbox((current) => current.map((entry) => entry.id === item.id ? updated : entry));
    } catch (cause) { setStatus("error"); setMessage(cause instanceof Error ? cause.message : "链接打开失败"); }
  }

  async function claimFile(item: DropItem) {
    if (!credential || (item.payload.type !== "image" && item.payload.type !== "file")) return;
    try {
      const blob = await fetchDropFile(credential, item.id);
      const path = await saveReceivedFile(blob, item.payload.fileName);
      const updated = await markDropStatus(credential, item.id, "claimed");
      setInbox((current) => current.map((entry) => entry.id === item.id ? updated : entry));
      setStatus("success"); setMessage(`已保存到 ${path}`);
    } catch (cause) { setStatus("error"); setMessage(cause instanceof Error ? cause.message : "文件保存失败"); }
  }

  const selectedDevice = useMemo(() => devices.find((device) => device.id === targetId), [devices, targetId]);
  const selectedPulse = useMemo(
    () => pulse?.devices.find((device) => device.name === selectedDevice?.name) ?? pulse?.devices[0],
    [pulse, selectedDevice]
  );

  return <main className="desktop-shell">
    <header className="desktop-header"><div className="desktop-brand"><span>z</span><strong>zxtoolkit</strong></div><i className={`online-dot ${connected ? "" : "is-offline"}`} title={connected ? "服务已连接" : "等待连接"} /></header>
    {settingsOpen && credential ? <section className="settings-pane">
      <button className="settings-back" onClick={() => setSettingsOpen(false)}><ArrowLeft size={15} /> 返回投递</button>
      <div className="settings-heading"><h1>设备管理</h1><p>长期凭证保存在 macOS 钥匙串，可随时轮换或吊销。</p></div>
      <label className="settings-field"><span>这台 Mac 的名称</span><div><input value={deviceName} maxLength={48} onChange={(event) => setDeviceName(event.target.value)} /><button onClick={() => void saveDeviceName()} disabled={!deviceName.trim()}>保存</button></div></label>
      <div className="settings-devices"><span>已配对设备</span>{devices.map((device) => <div key={device.id}><Smartphone size={16} /><p><strong>{device.name}</strong><small>{device.platform} · {device.revokedAt ? "已吊销" : "有效"}</small></p><button aria-label={`解除 ${device.name}`} onClick={() => void removePairedDevice(device.id)}><Trash2 size={16} /></button></div>)}</div>
      {pairing?.mode === "add_device" ? <div className="settings-pairing">
        <div><strong>扫描二维码添加设备</strong><small>二维码 10 分钟有效，只能确认一次。</small></div>
        <div className="settings-pairing-qr">{qrCode ? <img src={qrCode} alt="添加设备二维码" /> : <LoaderCircle className="spin" size={22} />}</div>
        <button onClick={() => void cancelActivePairing()}><X size={15} /> 取消添加</button>
      </div> : <button className="settings-action" onClick={() => void beginAddDevice()}><Plus size={16} /> 添加 Android 或 Web 设备</button>}
      <button className="settings-action" onClick={() => void rotateCredential()}><RotateCw size={16} /> 轮换这台 Mac 的凭证</button>
      <button className="settings-action danger" onClick={() => void quitApp()}><LogOut size={16} /> 退出 zxtoolkit</button>
      {message && <p className={`desktop-message ${status === "error" ? "error" : "success"}`}>{message}</p>}
    </section> : !credential || devices.length === 0 ? <section className="pairing-pane">
      <div className="pairing-copy"><h1>先绑定一台<br />接收设备。</h1><p>手机扫码确认后，以后无需再次扫码。</p></div>
      <div className="desktop-qr">{qrCode ? <img src={qrCode} alt="设备配对二维码" /> : <LoaderCircle className="spin" size={26} />}</div>
      <p className="pairing-hint">用手机相机扫描二维码</p>
      <button className="desktop-secondary" onClick={() => void beginPairing()}><RefreshCw size={15} /> 重新生成</button>
      {message && <p className="desktop-message error">{message}</p>}
    </section> : <>
      <section className="target-row"><span>投递到</span><label><Smartphone size={16} /><select value={targetId} onChange={(event) => { setTargetId(event.target.value); void store.saveDefaultDeviceId(event.target.value); }}>{devices.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</select><ChevronDown size={15} /></label></section>
      {screenshotPath && <section className="screenshot-prompt"><span><strong>检测到新截图</strong><small>{screenshotPath.split("/").pop()}</small></span><button onClick={() => void sendScreenshot()}>投递到 {selectedDevice?.name}</button><button className="dismiss" onClick={() => setScreenshotPath(null)}>忽略</button></section>}
      <section className="send-actions"><button className={`send-clipboard ${status === "success" ? "is-success" : ""}`} onClick={() => void sendClipboard()} disabled={status === "reading" || status === "sending"}>{status === "reading" || status === "sending" ? <LoaderCircle className="spin" size={19} /> : status === "success" ? <Check size={19} /> : <Clipboard size={19} />}<span><strong>{status === "reading" ? "正在读取" : status === "sending" ? progress ? `正在上传 ${progress}%` : "正在投递" : status === "success" ? "投递成功" : "发送剪贴板"}</strong><small>⌘⇧D · 文字、链接和图片</small></span></button><button className="file-action" onClick={() => fileInput.current?.click()}><FileUp size={18} /> 选择文件</button><input ref={fileInput} hidden type="file" onChange={(event) => void chooseFile(event.target.files?.[0])} /></section>
      <section className="drop-placeholder" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void chooseFile(event.dataTransfer.files[0]); }}>将文件拖到这里发送<span>20 MB</span></section>
      {message && <p className={`desktop-message ${status === "error" ? "error" : "success"}`}>{message}{status === "error" && lastAttempt && <button onClick={() => void retryLast()}>重试</button>}</p>}
      <section className="desktop-inbox"><div className="panel-title"><span><Inbox size={13} /> 收到的内容</span><label><input type="checkbox" checked={autoCopy} onChange={(event) => { setAutoCopy(event.target.checked); localStorage.setItem("zxtoolkit.auto-copy", event.target.checked ? "1" : "0"); }} /> 自动复制文字</label></div>{inbox.length ? inbox.slice(0,3).map((item) => <div className="desktop-inbox-item" id={`desktop-drop-${item.id}`} key={item.id}><span><strong>{summary(item)}</strong><small>{item.senderDeviceName} · {formatTime(item.createdAt)}</small></span>{item.status === "claimed" ? <small>已领取</small> : item.payload.type === "text" ? <button onClick={() => void claimText(item)}><Copy size={14} /> 复制</button> : item.payload.type === "url" ? <button onClick={() => void claimUrl(item)}><ExternalLink size={14} /> 打开</button> : <button onClick={() => void claimFile(item)}><Download size={14} /> 保存</button>}</div>) : <div className="recent-empty">手机发送的内容会出现在这里</div>}</section>
      <section className="recent-panel"><div className="panel-title"><span>最近投递</span><button onClick={() => credential && void refresh(credential)}><RefreshCw size={14} /></button></div>{recent.length ? <div className="recent-list">{recent.slice(0,4).map((item) => <div className="recent-item" key={item.id}><time>{formatTime(item.createdAt)}</time><span>{summary(item)}</span><small>{statusText(item.status)}</small></div>)}</div> : <div className="recent-empty">发送后的内容会出现在这里</div>}</section>
      <section className="pulse-summary"><div className="panel-title"><span>设备状态</span><button onClick={() => void openExternal(`${publicAppUrl.replace(/\/$/, "")}/pulse/preview`)}>Pulse</button></div><div><span>{selectedPulse?.name ?? selectedDevice?.name}</span><small>{selectedPulse ? `${presenceText(selectedPulse.presence)} · 电量${batteryText(selectedPulse.batteryLevel)} · ${selectedPulse.charging ? "充电中" : "未充电"}` : "等待状态"}</small></div></section>
      <footer className="desktop-footer"><button onClick={() => { setMessage(null); setSettingsOpen(true); }}><Settings size={14} /> 设备管理</button><button onClick={() => void openExternal(`${publicAppUrl.replace(/\/$/, "")}/inbox`)}><ExternalLink size={14} /> Web 收件箱</button></footer>
      <p className="target-footnote">当前目标：{selectedDevice?.name}</p>
    </>}
  </main>;
}

function summary(item: DropItem): string { return item.payload.type === "url" ? item.payload.url.replace(/^https?:\/\//, "") : item.payload.type === "image" || item.payload.type === "file" ? item.payload.fileName : item.payload.text.replace(/\s+/g, " "); }
function kindLabel(item: DropItem): string { return item.payload.type === "text" ? "一段文字" : item.payload.type === "url" ? "一个链接" : item.payload.type === "image" ? "一张图片" : "一个文件"; }
function formatTime(value: string): string { return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); }
function statusText(value: DropItem["status"]): string { return value === "claimed" ? "已领取" : value === "opened" ? "已打开" : value === "delivered" ? "已送达" : value === "expired" ? "已过期" : value === "failed" ? "失败" : "发送中"; }
function presenceText(value: "online" | "recently_online" | "offline"): string { return value === "online" ? "在线" : value === "recently_online" ? "最近在线" : "离线"; }
function batteryText(value: "high" | "medium" | "low" | undefined): string { return value === "high" ? "高" : value === "medium" ? "中" : value === "low" ? "低" : "未知"; }
