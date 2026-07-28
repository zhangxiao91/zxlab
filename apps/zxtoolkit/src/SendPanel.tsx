import { useEffect, useRef, useState } from "react";
import { Camera, Check, FileUp, Image as ImageIcon, LoaderCircle, Send } from "lucide-react";
import type { Device, DeviceCredential, DropItem } from "../shared/types";
import { classifyClipboard, payloadForFile } from "../shared/payload";
import { getDevices, sendDrop, uploadDropFile } from "./lib/device-api";
import { formatBytes } from "./lib/files";

export function SendPanel({ credential, onSent }: { credential: DeviceCredential; onSent: (item: DropItem) => void }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [targetId, setTargetId] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "sending" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const imageInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void getDevices(credential).then(({ pairedDevices }) => {
      setDevices(pairedDevices);
      setTargetId((current) => current || pairedDevices[0]?.id || "");
    }).catch((cause) => {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : "无法读取已配对设备");
    });
  }, [credential]);

  async function submit() {
    if (!targetId || status === "sending") return;
    const payload = file ? payloadForFile(file) : text.trim() ? classifyClipboard(text) : null;
    if (!payload) {
      setStatus("error");
      setMessage(file ? "文件无效或超过 100 MB" : "请输入文字、链接，或选择图片和文件");
      return;
    }
    setStatus("sending");
    setMessage("");
    setProgress(0);
    try {
      const created = await sendDrop(credential, targetId, payload);
      const delivered = file ? await uploadDropFile(credential, created, file, setProgress).promise : created;
      onSent(delivered);
      setStatus("success");
      setMessage(`已投递到 ${devices.find((device) => device.id === targetId)?.name ?? "目标设备"}`);
      setText("");
      setFile(null);
      window.setTimeout(() => setStatus("idle"), 1800);
    } catch (cause) {
      setStatus("error");
      setMessage(cause instanceof Error ? cause.message : "投递失败，请稍后重试");
    }
  }

  function choose(selected: File | undefined) {
    if (!selected) return;
    setFile(selected);
    setText("");
    setMessage(selected.size > 100_000_000 ? "单个文件不能超过 100 MB" : "");
    setStatus(selected.size > 100_000_000 ? "error" : "idle");
  }

  return <section className="send-panel">
    <div className="send-panel-head"><div><h2>投递内容</h2><p>发给任意已配对设备，内容默认保留 24 小时。</p></div>
      <label>投递到<select value={targetId} onChange={(event) => setTargetId(event.target.value)}>{devices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</select></label>
    </div>
    <textarea value={text} onChange={(event) => { setText(event.target.value); setFile(null); }} placeholder="粘贴文字或链接…" maxLength={20_000} />
    {file && <div className="send-file-preview">{file.type.startsWith("image/") ? <ImageIcon size={20} /> : <FileUp size={20} />}<span><strong>{file.name}</strong><small>{formatBytes(file.size)} · {file.type || "未知类型"}</small></span><button onClick={() => setFile(null)}>移除</button></div>}
    <div className="send-source-actions">
      <button onClick={() => imageInput.current?.click()}><Camera size={17} /> 拍照或相册</button>
      <button onClick={() => fileInput.current?.click()}><FileUp size={17} /> 选择文件</button>
      <input ref={imageInput} hidden type="file" accept="image/*" capture="environment" onChange={(event) => choose(event.target.files?.[0])} />
      <input ref={fileInput} hidden type="file" onChange={(event) => choose(event.target.files?.[0])} />
    </div>
    <button className="utility-primary send-submit" onClick={() => void submit()} disabled={!targetId || status === "sending"}>
      {status === "sending" ? <><LoaderCircle className="spin" size={18} /> {progress ? `正在上传 ${progress}%` : "正在投递"}</> : status === "success" ? <><Check size={18} /> 投递完成</> : <><Send size={18} /> 发送到设备</>}
    </button>
    {message && <p className={status === "error" ? "utility-error" : "utility-note"}>{message}</p>}
  </section>;
}
