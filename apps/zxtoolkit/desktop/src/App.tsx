import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { ArrowLeft, Check, ChevronDown, Clipboard, ExternalLink, FileUp, LoaderCircle, LogOut, RefreshCw, RotateCw, Settings, Smartphone, Trash2 } from "lucide-react";
import type { Device, DeviceCredential, DropItem, PairingSessionResponse, PublicStatusResponse } from "../../shared/types";
import { ApiError } from "../../src/lib/api";
import { createPairingSession, getDevices, getPairingStatus, getPublicStatus, getRecentDrops, removeDevice, renameCurrentDevice, rotateDeviceCredential, sendDrop, uploadDropImage } from "../../src/lib/device-api";
import { createCredentialStore, notifyDelivery, openExternal, quitApp, readClipboardDrop, resolveDefaultDeviceId, type ClipboardDrop } from "./platform";

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
          await store.saveCredential(result.credential);
          await store.saveDefaultDeviceId(result.receiver.id);
          setCredential(result.credential); setDeviceName(result.credential.device.name); setPairing(null); setQrCode(null);
          await refresh(result.credential);
        } else if (result.status === "expired") {
          window.clearInterval(timer); setMessage("配对二维码已过期，请重新生成");
        }
      } catch { /* next poll retries */ }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [pairing, refresh]);

  async function beginPairing() {
    setMessage(null); setQrCode(null);
    try { setPairing(await createPairingSession("我的 Mac")); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "无法创建配对二维码"); }
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

  async function deliver(drop: ClipboardDrop) {
    if (!credential || !targetId) return;
    setStatus("sending"); setProgress(0); setMessage(null);
    const created = await sendDrop(credential, targetId, drop.payload);
    const item = drop.payload.type === "image" && drop.blob
      ? await uploadDropImage(credential, created, drop.blob, setProgress).promise
      : created;
    setRecent((current) => [item, ...current.filter((entry) => entry.id !== item.id)].slice(0, 20));
    setStatus("success"); setProgress(100);
    const deliveredMessage = drop.payload.type === "url" ? "链接已投递" : drop.payload.type === "image" ? "图片已投递" : "文字已投递";
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

  const selectedDevice = useMemo(() => devices.find((device) => device.id === targetId), [devices, targetId]);

  return <main className="desktop-shell">
    <header className="desktop-header"><div className="desktop-brand"><span>z</span><strong>zxtoolkit</strong></div><i className={`online-dot ${connected ? "" : "is-offline"}`} title={connected ? "服务已连接" : "等待连接"} /></header>
    {settingsOpen && credential ? <section className="settings-pane">
      <button className="settings-back" onClick={() => setSettingsOpen(false)}><ArrowLeft size={15} /> 返回投递</button>
      <div className="settings-heading"><h1>设备管理</h1><p>长期凭证保存在 macOS 钥匙串，可随时轮换或吊销。</p></div>
      <label className="settings-field"><span>这台 Mac 的名称</span><div><input value={deviceName} maxLength={48} onChange={(event) => setDeviceName(event.target.value)} /><button onClick={() => void saveDeviceName()} disabled={!deviceName.trim()}>保存</button></div></label>
      <div className="settings-devices"><span>已配对设备</span>{devices.map((device) => <div key={device.id}><Smartphone size={16} /><p><strong>{device.name}</strong><small>{device.platform} · {device.revokedAt ? "已吊销" : "有效"}</small></p><button aria-label={`解除 ${device.name}`} onClick={() => void removePairedDevice(device.id)}><Trash2 size={16} /></button></div>)}</div>
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
      <section className="send-actions"><button className={`send-clipboard ${status === "success" ? "is-success" : ""}`} onClick={() => void sendClipboard()} disabled={status === "reading" || status === "sending"}>{status === "reading" || status === "sending" ? <LoaderCircle className="spin" size={19} /> : status === "success" ? <Check size={19} /> : <Clipboard size={19} />}<span><strong>{status === "reading" ? "正在读取" : status === "sending" ? progress ? `正在上传 ${progress}%` : "正在投递" : status === "success" ? "投递成功" : "发送剪贴板"}</strong><small>支持文字、链接和图片</small></span></button><button className="file-action" disabled title="文件投递将在后续版本开放"><FileUp size={18} /> 选择文件</button></section>
      <section className="drop-placeholder">将文件拖到这里发送<span>即将开放</span></section>
      {message && <p className={`desktop-message ${status === "error" ? "error" : "success"}`}>{message}{status === "error" && lastAttempt && <button onClick={() => void retryLast()}>重试</button>}</p>}
      <section className="recent-panel"><div className="panel-title"><span>最近投递</span><button onClick={() => credential && void refresh(credential)}><RefreshCw size={14} /></button></div>{recent.length ? <div className="recent-list">{recent.slice(0,4).map((item) => <div className="recent-item" key={item.id}><time>{formatTime(item.createdAt)}</time><span>{summary(item)}</span><small>{statusText(item.status)}</small></div>)}</div> : <div className="recent-empty">发送后的内容会出现在这里</div>}</section>
      <section className="pulse-summary"><div className="panel-title"><span>设备状态</span><button onClick={() => void openExternal(`${publicAppUrl.replace(/\/$/, "")}/pulse/preview`)}>Pulse</button></div><div><span>{pulse?.devices[0]?.name ?? selectedDevice?.name}</span><small>{pulse?.devices[0]?.presence === "online" ? "在线" : "等待状态"}</small></div></section>
      <footer className="desktop-footer"><button onClick={() => { setMessage(null); setSettingsOpen(true); }}><Settings size={14} /> 设备管理</button><button onClick={() => void openExternal(`${publicAppUrl.replace(/\/$/, "")}/inbox`)}><ExternalLink size={14} /> Web 收件箱</button></footer>
      <p className="target-footnote">当前目标：{selectedDevice?.name}</p>
    </>}
  </main>;
}

function summary(item: DropItem): string { return item.payload.type === "url" ? item.payload.url.replace(/^https?:\/\//, "") : item.payload.type === "image" ? item.payload.fileName : item.payload.text.replace(/\s+/g, " "); }
function formatTime(value: string): string { return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); }
function statusText(value: DropItem["status"]): string { return value === "claimed" ? "已领取" : value === "opened" ? "已打开" : value === "delivered" ? "已送达" : value === "expired" ? "已过期" : value === "failed" ? "失败" : "发送中"; }
