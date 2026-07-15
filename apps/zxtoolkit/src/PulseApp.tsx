import { useEffect, useMemo, useState } from "react";
import { Activity, ArrowLeft, BatteryCharging, Eye, LoaderCircle, RefreshCw, Send } from "lucide-react";
import type { BatteryLevel, PublicPulseSnapshot, PublicStatusResponse, StepsBucket } from "../shared/types";
import { getPublicStatus, loadWebCredential, publishPulse } from "./lib/device-api";

export default function PulseApp() { return window.location.pathname === "/pulse/preview" ? <PublicPreview /> : <PulsePublisher />; }

function PulsePublisher() {
  const credential = useMemo(() => loadWebCredential(), []);
  const [battery, setBattery] = useState<BatteryLevel>("high");
  const [charging, setCharging] = useState(true);
  const [steps, setSteps] = useState<StepsBucket>("8k-12k");
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [message, setMessage] = useState("当前使用开发态模拟 Provider，上传前可检查全部公开字段。");
  const snapshot = useMemo((): PublicPulseSnapshot => { const now = Date.now(); return { device: { presence: "online", batteryLevel: battery, charging }, activity: { stepsBucket: steps }, generatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 60_000).toISOString(), schemaVersion: 1 }; }, [battery, charging, steps]);
  async function submit() { if (!credential) return; setStatus("sending"); try { await publishPulse(credential, snapshot); setStatus("success"); setMessage("公开快照已发布，30 分钟后自动失效。"); } catch (cause) { setStatus("error"); setMessage(cause instanceof Error ? cause.message : "Pulse 发布失败"); } }
  return <main className="utility-page pulse-page"><header className="utility-nav"><a href="/inbox"><ArrowLeft size={16} /> zxtoolkit</a><a href="/pulse/preview"><Eye size={15} /> 公开预览</a></header><section className="inbox-heading"><div><p className="utility-kicker"><Activity size={15} /> Pulse · 开发态数据</p><h1>发布设备状态</h1><p>只有下方预览中的脱敏字段会发送到服务端。</p></div></section>{!credential ? <section className="inbox-empty"><h2>请先配对这台设备</h2><p>从 Mac 菜单栏扫描配对二维码后再发布 Pulse。</p></section> : <section className="pulse-controls"><label>电量档位<select value={battery} onChange={(event) => setBattery(event.target.value as BatteryLevel)}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label><label className="pulse-check"><input type="checkbox" checked={charging} onChange={(event) => setCharging(event.target.checked)} /><BatteryCharging size={17} /> 正在充电</label><label>今日步数档位<select value={steps} onChange={(event) => setSteps(event.target.value as StepsBucket)}>{["0-2k","2k-5k","5k-8k","8k-12k","12k+"].map((value) => <option key={value}>{value}</option>)}</select></label><div className="pulse-json"><strong>zxlab Status 将看到</strong><pre>{JSON.stringify(snapshot, null, 2)}</pre></div><button className="utility-primary" onClick={() => void submit()} disabled={status === "sending"}>{status === "sending" ? <LoaderCircle className="spin" size={18} /> : <Send size={18} />} 发布公开快照</button><p className={status === "error" ? "utility-error" : "utility-note"}>{message}</p></section>}</main>;
}

function PublicPreview() {
  const [data, setData] = useState<PublicStatusResponse | null>(null); const [error, setError] = useState<string | null>(null);
  const refresh = async () => { try { setData(await getPublicStatus()); setError(null); } catch { setError("公开状态暂时不可用"); } };
  useEffect(() => { void refresh(); }, []);
  return <main className="utility-page pulse-page"><header className="utility-nav"><a href="/pulse"><ArrowLeft size={16} /> Pulse</a><button onClick={() => void refresh()}><RefreshCw size={15} /> 刷新</button></header><section className="inbox-heading"><div><p className="utility-kicker"><Eye size={15} /> 无需登录的公开边界</p><h1>公开状态预览</h1><p>这里与 zxlab Status 读取同一份 API，不包含设备 ID、系统版本或精确健康数据。</p></div></section>{data?.devices.length ? <section className="pulse-public">{data.devices.map((device) => <article key={device.name}><strong>{device.name}</strong><span>{device.presence === "online" ? "在线" : device.presence === "recently_online" ? "最近在线" : "离线"}</span><p>电量 {device.batteryLevel ?? "未公开"} · {device.charging ? "充电中" : "未充电"}</p></article>)}<p>今日步数：{data.activity?.stepsBucket ?? "未公开"}</p><small>更新于 {data.updatedAt ? new Date(data.updatedAt).toLocaleString("zh-CN") : "暂无"}</small></section> : <section className="inbox-empty"><Activity size={34} /><h2>暂无有效公开快照</h2><p>快照过期后不会继续显示为当前状态。</p></section>}{error && <p className="utility-error">{error}</p>}</main>;
}
