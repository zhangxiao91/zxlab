import { useCallback, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { Check, ChevronDown, Clipboard, ExternalLink, FileUp, LoaderCircle, RefreshCw, Settings, Smartphone } from "lucide-react";
import type { Device, DeviceCredential, DropItem, PairingSessionResponse } from "../../shared/types";
import { classifyClipboard } from "../../shared/payload";
import { createPairingSession, getDevices, getPairingStatus, getRecentDrops, removeDevice, sendDrop } from "../../src/lib/device-api";
import { createCredentialStore, openExternal, readClipboardText } from "./platform";

const store = createCredentialStore();
const publicAppUrl = import.meta.env.VITE_PUBLIC_APP_URL || "http://localhost:4173";

export default function DesktopApp() {
  const [credential, setCredential] = useState<DeviceCredential | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [targetId, setTargetId] = useState("");
  const [recent, setRecent] = useState<DropItem[]>([]);
  const [pairing, setPairing] = useState<PairingSessionResponse | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "reading" | "sending" | "success" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async (active: DeviceCredential) => {
    const [deviceResult, recentResult] = await Promise.all([getDevices(active), getRecentDrops(active)]);
    setDevices(deviceResult.pairedDevices);
    setRecent(recentResult);
    const storedDefault = await store.loadDefaultDeviceId();
    const next = deviceResult.pairedDevices.some((item) => item.id === storedDefault) ? storedDefault! : deviceResult.pairedDevices[0]?.id ?? "";
    setTargetId(next);
    if (next) await store.saveDefaultDeviceId(next);
  }, []);

  useEffect(() => {
    void store.loadCredential().then(async (saved) => {
      if (!saved) { await beginPairing(); return; }
      setCredential(saved);
      try { await refresh(saved); } catch { await store.clear(); setCredential(null); await beginPairing(); }
    });
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
          setCredential(result.credential); setPairing(null); setQrCode(null);
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
    if (!credential || !targetId) return;
    setStatus("reading"); setMessage(null);
    try {
      const text = (await readClipboardText()).trim();
      if (!text) throw new Error("剪贴板是空的，请先复制文字或链接");
      const payload = classifyClipboard(text);
      setStatus("sending");
      const item = await sendDrop(credential, targetId, payload);
      setRecent((current) => [item, ...current.filter((entry) => entry.id !== item.id)].slice(0, 10));
      setStatus("success"); setMessage(payload.type === "url" ? "链接已投递" : "文字已投递");
      window.setTimeout(() => { setStatus("idle"); setMessage(null); }, 2200);
    } catch (cause) {
      setStatus("error"); setMessage(cause instanceof Error ? cause.message : "发送失败，请稍后重试");
    }
  }

  async function removeCurrentDevice() {
    if (!credential || !targetId || !selectedDevice) return;
    if (!window.confirm(`解除与“${selectedDevice.name}”的绑定？解除后需要重新扫码才能投递。`)) return;
    try {
      await removeDevice(credential, targetId);
      const remaining = devices.filter((device) => device.id !== targetId);
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

  const selectedDevice = useMemo(() => devices.find((device) => device.id === targetId), [devices, targetId]);

  return <main className="desktop-shell">
    <header className="desktop-header"><div className="desktop-brand"><span>z</span><strong>zxdrop</strong></div><i className="online-dot" /></header>
    {!credential || devices.length === 0 ? <section className="pairing-pane">
      <div className="pairing-copy"><h1>先绑定一台<br />接收设备。</h1><p>手机扫码确认后，以后无需再次扫码。</p></div>
      <div className="desktop-qr">{qrCode ? <img src={qrCode} alt="设备配对二维码" /> : <LoaderCircle className="spin" size={26} />}</div>
      <p className="pairing-hint">用手机相机扫描二维码</p>
      <button className="desktop-secondary" onClick={() => void beginPairing()}><RefreshCw size={15} /> 重新生成</button>
      {message && <p className="desktop-message error">{message}</p>}
    </section> : <>
      <section className="target-row"><span>投递到</span><label><Smartphone size={16} /><select value={targetId} onChange={(event) => { setTargetId(event.target.value); void store.saveDefaultDeviceId(event.target.value); }}>{devices.map((device) => <option value={device.id} key={device.id}>{device.name}</option>)}</select><ChevronDown size={15} /></label></section>
      <section className="send-actions"><button className={`send-clipboard ${status === "success" ? "is-success" : ""}`} onClick={() => void sendClipboard()} disabled={status === "reading" || status === "sending"}>{status === "reading" || status === "sending" ? <LoaderCircle className="spin" size={19} /> : status === "success" ? <Check size={19} /> : <Clipboard size={19} />}<span><strong>{status === "reading" ? "正在读取" : status === "sending" ? "正在投递" : status === "success" ? "投递成功" : "发送剪贴板"}</strong><small>支持文字和链接</small></span></button><button className="file-action" disabled title="文件投递将在后续版本开放"><FileUp size={18} /> 选择文件</button></section>
      <section className="drop-placeholder">将文件拖到这里发送<span>即将开放</span></section>
      {message && <p className={`desktop-message ${status === "error" ? "error" : "success"}`}>{message}{status === "error" && <button onClick={() => void sendClipboard()}>重试</button>}</p>}
      <section className="recent-panel"><div className="panel-title"><span>最近投递</span><button onClick={() => credential && void refresh(credential)}><RefreshCw size={14} /></button></div>{recent.length ? <div className="recent-list">{recent.slice(0,4).map((item) => <div className="recent-item" key={item.id}><time>{formatTime(item.createdAt)}</time><span>{summary(item)}</span><small>{statusText(item.status)}</small></div>)}</div> : <div className="recent-empty">发送后的内容会出现在这里</div>}</section>
      <footer className="desktop-footer"><button onClick={() => void removeCurrentDevice()}><Settings size={14} /> 解除当前设备</button><button onClick={() => void openExternal(`${publicAppUrl.replace(/\/$/, "")}/inbox`)}><ExternalLink size={14} /> 打开收件箱</button></footer>
      <p className="target-footnote">当前目标：{selectedDevice?.name}</p>
    </>}
  </main>;
}

function summary(item: DropItem): string { return item.payload.type === "url" ? item.payload.url.replace(/^https?:\/\//, "") : item.payload.text.replace(/\s+/g, " "); }
function formatTime(value: string): string { return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }); }
function statusText(value: DropItem["status"]): string { return value === "opened" ? "已打开" : value === "delivered" ? "已送达" : value === "expired" ? "已过期" : "发送中"; }
