import { useMemo, useState } from "react";
import { ArrowLeft, Check, LoaderCircle, ShieldCheck } from "lucide-react";
import type { DeviceType } from "../shared/types";
import { confirmPairing, saveWebCredential } from "./lib/device-api";

export default function PairApp() {
  const pairingId = useMemo(() => window.location.pathname.split("/").filter(Boolean)[1] ?? "", []);
  const [name, setName] = useState("我的手机");
  const [type, setType] = useState<DeviceType>(/iPad/i.test(navigator.userAgent) ? "tablet" : /Windows/i.test(navigator.userAgent) ? "windows" : "phone");
  const [status, setStatus] = useState<"ready" | "submitting" | "done">("ready");
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (!name.trim() || !pairingId) return;
    setStatus("submitting"); setError(null);
    try {
      const credential = await confirmPairing(pairingId, name.trim(), type);
      saveWebCredential(credential);
      setStatus("done");
      window.setTimeout(() => window.location.assign("/inbox"), 700);
    } catch (cause) {
      setStatus("ready");
      setError(cause instanceof Error ? cause.message : "配对失败，请在 Mac 上重新生成二维码");
    }
  }

  return <main className="utility-page">
    <header className="utility-nav"><a href="/"><ArrowLeft size={16} /> zxdrop</a><span>设备配对</span></header>
    <section className="pair-shell">
      <div className="pair-copy"><p className="utility-kicker"><ShieldCheck size={15} /> 一次性配对</p><h1>给这台设备<br />起个名字。</h1><p>确认后，它会成为这台 Mac 的长期投递目标。二维码只需扫描一次。</p></div>
      <div className="pair-form">
        {status === "done" ? <div className="pair-success"><Check size={30} /><strong>配对完成</strong><span>正在打开收件箱</span></div> : <>
          <label>设备名称<input value={name} maxLength={48} onChange={(event) => setName(event.target.value)} /></label>
          <label>设备类型<select value={type} onChange={(event) => setType(event.target.value as DeviceType)}><option value="phone">手机</option><option value="tablet">iPad / 平板</option><option value="windows">Windows 电脑</option><option value="web">其他 Web 设备</option></select></label>
          <button className="utility-primary" onClick={() => void confirm()} disabled={status === "submitting" || !name.trim()}>{status === "submitting" ? <><LoaderCircle className="spin" size={18} /> 正在配对</> : "确认配对"}</button>
          {error && <p className="utility-error">{error}</p>}
        </>}
      </div>
    </section>
    <p className="privacy-line">配对码 10 分钟有效且只能使用一次。zxdrop 不会自动读取此设备的剪贴板。</p>
  </main>;
}
