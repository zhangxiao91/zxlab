import React, { useMemo, useState } from "react";
import type {
  DossierFactAnchor,
  DossierFactDelta,
  DossierProposalStatus,
  AlertRuleDraft,
  ManualThesisOperation,
  ResearchDossier,
  ResearchDossierProposal,
  ResearchDossierRevision,
  ResearchDossierProjection,
  ThesisImpact,
} from "@zxlab/market-agent-schema";
import type {
  AlertRuleDraftInput,
  AlertRuleDraftView,
  ResearchDossierSourceRun,
} from "./client";

export interface DossierProposalView {
  id: string;
  status: DossierProposalStatus;
  expiresAt: string;
}

export interface DossierProjectionView {
  proposal: DossierProposalView;
  projection: ResearchDossierProjection;
}

export type DossierAction = "confirm" | "dismiss" | "alert" | "rebase" | "thesis" | "purge" | null;
export type DossierAlertDraftInput = AlertRuleDraftInput extends infer T
  ? T extends { idempotencyKey: string } ? Omit<T, "idempotencyKey"> : never
  : never;
type DossierAlertTemplate = DossierAlertDraftInput["template"];
type DossierAlertField = "value" | "yoy" | "qoq";

export function dossierAlertTemplateOptions(delta: Pick<DossierFactDelta, "kind">): DossierAlertTemplate[] {
  return delta.kind === "period_advanced"
    ? ["new_reporting_period", "metric_threshold_crossing"]
    : ["metric_threshold_crossing"];
}

export function dossierAlertFieldOptions(anchor: Pick<DossierFactAnchor, "comparisons">): DossierAlertField[] {
  const kinds = new Set(anchor.comparisons.map((comparison) => comparison.kind));
  return ["value", ...(kinds.has("yoy") ? ["yoy" as const] : []), ...(kinds.has("qoq") ? ["qoq" as const] : [])];
}

export interface DossierProjectionSectionProps {
  view: DossierProjectionView | null;
  loading: boolean;
  error: string | null;
  busyAction: DossierAction;
  onConfirm(acceptedThesisImpactIds: string[]): Promise<void>;
  onDismiss(): Promise<void>;
  revisionConflict?: boolean;
  onRebase?(): Promise<void>;
  onCreateAlertDraft(input: DossierAlertDraftInput): Promise<AlertRuleDraftView>;
  onEvidence(evidenceId: string): void;
}

export function DossierProjectionSection({
  view,
  loading,
  error,
  busyAction,
  onConfirm,
  onDismiss,
  revisionConflict = false,
  onRebase = async () => undefined,
  onCreateAlertDraft,
  onEvidence,
}: DossierProjectionSectionProps) {
  const [acceptedImpacts, setAcceptedImpacts] = useState<string[]>([]);
  const [alertOpen, setAlertOpen] = useState(false);

  if (loading && !view) {
    return <section className="dossier-projection dossier-projection--loading" aria-label="本次研究档案变化" aria-live="polite"><p>正在核对本次 Fact 与已确认研究档案。</p></section>;
  }
  if (!view && !error) return null;
  if (!view) {
    return <section className="dossier-projection dossier-projection--error" aria-label="本次研究档案变化" role="status"><strong>研究档案变化暂不可用</strong><p>{error}</p></section>;
  }

  const { projection, proposal } = view;
  const reliableDeltas = projection.factDeltas.filter((delta) => delta.current.quality.reliable);
  const pending = proposal.status === "pending";
  const firstBaseline = projection.base.dossierVersion === 0;
  return <section className="dossier-projection" aria-label="本次研究档案变化" data-quality={projection.quality.status}>
    <header className="dossier-projection__header">
      <div>
        <h3>本次研究档案变化</h3>
        <p>{firstBaseline ? "首次研究基线：确认后才会建立长期档案。" : `相对 Dossier revision ${projection.base.dossierVersion} 的待确认变化。`}</p>
      </div>
      <span>{proposalStatusLabel(proposal.status)}</span>
    </header>

    <div className="dossier-projection__deltas">
      {projection.factDeltas.map((delta) => <DossierDeltaCard key={delta.id} delta={delta} onEvidence={onEvidence} />)}
    </div>

    {projection.thesisImpacts.length > 0 && <section className="dossier-projection__theses" aria-label="Thesis impacts">
      <header><h4>Thesis impacts</h4><p>模型只做影响分类；不会改写你的 thesis。</p></header>
      <div>{projection.thesisImpacts.map((impact) => <ThesisImpactChoice
        key={impact.id}
        impact={impact}
        checked={acceptedImpacts.includes(impact.id)}
        disabled={!pending || busyAction !== null}
        onChange={(checked) => setAcceptedImpacts((current) => checked ? [...current, impact.id] : current.filter((id) => id !== impact.id))}
      />)}</div>
    </section>}

    {projection.quality.limitations.length > 0 && <div className="dossier-projection__limitations" role="status"><strong>本次 projection 有数据边界</strong><ul>{projection.quality.limitations.map((item) => <li key={item.code}>{item.code}</li>)}</ul></div>}
    {revisionConflict && <div className="dossier-projection__conflict" role="status"><div><strong>DOSSIER_REVISION_CONFLICT</strong><p>{error ?? "Dossier 已前进，当前 proposal 不会被静默 rebase。"}</p></div><button type="button" className="dossier-action" onClick={() => void onRebase().catch(() => undefined)} disabled={busyAction !== null}>{busyAction === "rebase" ? "正在重新投影" : "基于最新 revision 重新投影"}</button></div>}

    <footer className="dossier-projection__actions">
      <p>确认后会形成独立于 Run 保留期的长期研究记录。Fact delta 作为完整切片确认；Alert 草案不会激活提醒。</p>
      <div>
        <button type="button" className="dossier-action dossier-action--primary" onClick={() => void onConfirm(acceptedImpacts).catch(() => undefined)} disabled={!pending || busyAction !== null || projection.factDeltas.length === 0}>{busyAction === "confirm" ? "正在确认" : "确认更新档案"}</button>
        <button type="button" className="dossier-action" onClick={() => setAlertOpen(true)} disabled={!pending || busyAction !== null || reliableDeltas.length === 0}>转为 Alert 草案</button>
        <button type="button" className="dossier-action dossier-action--quiet" onClick={() => void onDismiss().catch(() => undefined)} disabled={!pending || busyAction !== null}>{busyAction === "dismiss" ? "正在处理" : "暂不处理"}</button>
      </div>
    </footer>

    {alertOpen && <AlertRuleDraftDialog
      deltas={reliableDeltas}
      busy={busyAction === "alert"}
      onClose={() => setAlertOpen(false)}
      onCreate={onCreateAlertDraft}
    />}
  </section>;
}

function DossierDeltaCard({ delta, onEvidence }: { delta: DossierFactDelta; onEvidence(evidenceId: string): void }) {
  const current = delta.current;
  return <article className="dossier-delta" data-reliable={current.quality.reliable}>
    <header>
      <div><span>{deltaKindLabel(delta.kind)}</span><h4>{metricLabel(current.metric)}</h4></div>
      <strong>{current.quality.reliable ? "可靠锚点" : "未验证观察"}</strong>
    </header>
    <div className="dossier-delta__comparison">
      <FactAnchorValue label={delta.previous ? "档案原值" : "档案原值"} anchor={delta.previous} />
      <span aria-hidden="true">→</span>
      <FactAnchorValue label="本次 Fact" anchor={current} />
    </div>
    {!current.quality.reliable && <p className="dossier-delta__warning">这项 Fact 不会覆盖既有可靠锚点，也不能单独支持 thesis。</p>}
    {current.comparisons.length > 0 && <dl className="dossier-delta__ratios">{current.comparisons.map((comparison) => <div key={comparison.kind}><dt>{comparison.kind.toUpperCase()}</dt><dd>{formatRatio(comparison.decimal)}</dd></div>)}</dl>}
    <div className="dossier-delta__meta"><span>{formatPeriod(current)}</span><span>as-of {shortDate(current.provenance.sourceAsOf)}</span><button type="button" onClick={() => onEvidence(current.evidenceId)}>查看 Evidence</button></div>
  </article>;
}

function FactAnchorValue({ label, anchor }: { label: string; anchor: DossierFactAnchor | null }) {
  return <div><span>{label}</span><strong>{anchor ? formatDecimal(anchor.value.decimal, anchor.value.unit) : "尚无基线"}</strong><small>{anchor ? unitLabel(anchor.value.unit) : "确认后创建"}</small></div>;
}

function ThesisImpactChoice({ impact, checked, disabled, onChange }: { impact: ThesisImpact; checked: boolean; disabled: boolean; onChange(checked: boolean): void }) {
  return <label className="dossier-thesis-impact" data-impact={impact.impact}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
    <span><strong>{thesisImpactLabel(impact.impact)}</strong><small>{impact.thesisId}</small><p>{impact.explanation}</p></span>
  </label>;
}

function AlertRuleDraftDialog({ deltas, busy, onClose, onCreate }: {
  deltas: DossierFactDelta[];
  busy: boolean;
  onClose(): void;
  onCreate(input: DossierAlertDraftInput): Promise<AlertRuleDraftView>;
}) {
  const [deltaId, setDeltaId] = useState(deltas[0]?.id ?? "");
  const [template, setTemplate] = useState<DossierAlertTemplate>(() => deltas[0] ? dossierAlertTemplateOptions(deltas[0])[0]! : "metric_threshold_crossing");
  const [field, setField] = useState<DossierAlertField>("value");
  const [operator, setOperator] = useState<"crosses_above" | "crosses_below">("crosses_above");
  const [threshold, setThreshold] = useState("");
  const [created, setCreated] = useState<AlertRuleDraftView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = useMemo(() => deltas.find((delta) => delta.id === deltaId) ?? deltas[0], [deltaId, deltas]);
  const templateOptions = selected ? dossierAlertTemplateOptions(selected) : [];
  const fieldOptions = selected ? dossierAlertFieldOptions(selected.current) : [];
  const thresholdValid = isDossierThresholdDecimal(threshold);
  const selectionAllowed = templateOptions.includes(template)
    && (template === "new_reporting_period" || fieldOptions.includes(field));
  const canSubmit = Boolean(selected) && selectionAllowed && (template === "new_reporting_period" || thresholdValid);

  const selectDelta = (nextId: string) => {
    setDeltaId(nextId);
    const next = deltas.find((delta) => delta.id === nextId);
    if (!next) return;
    const nextTemplates = dossierAlertTemplateOptions(next);
    setTemplate((current) => nextTemplates.includes(current) ? current : nextTemplates[0]!);
    const nextFields = dossierAlertFieldOptions(next.current);
    setField((current) => nextFields.includes(current) ? current : nextFields[0]!);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected || !canSubmit) return;
    setError(null);
    try {
      const result = await onCreate(template === "new_reporting_period" ? {
        deltaId: selected.id,
        template,
      } : {
        deltaId: selected.id,
        template,
        field,
        operator,
        threshold,
      });
      setCreated(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Alert 草案未能创建");
    }
  };

  return <div className="dossier-alert-dialog" role="dialog" aria-modal="true" aria-labelledby="dossier-alert-title">
    <div className="dossier-alert-dialog__surface">
      <header><div><h4 id="dossier-alert-title">创建 Alert Rule Draft</h4><p>草案不会激活提醒，也不会触发交易。</p></div><button type="button" onClick={onClose} aria-label="关闭 Alert 草案">关闭</button></header>
      {created ? <div className="dossier-alert-dialog__success" role="status"><strong>Alert 草案已建立</strong><p>状态仍为 draft，需在后续规则流程中另行确认。</p><code>{created.id}</code><button type="button" onClick={onClose}>完成</button></div> : <form onSubmit={(event) => void submit(event)}>
        <label><span>事实变化</span><select value={deltaId} disabled={busy} onChange={(event) => selectDelta(event.currentTarget.value)}>{deltas.map((delta) => <option key={delta.id} value={delta.id}>{metricLabel(delta.current.metric)} · {deltaKindLabel(delta.kind)}</option>)}</select><small>标的、metric、期间与 Evidence 由服务端从 projection 固定。</small></label>
        <label><span>规则模板</span><select value={template} disabled={busy} onChange={(event) => setTemplate(event.currentTarget.value as DossierAlertTemplate)}>{templateOptions.map((option) => <option key={option} value={option}>{option === "new_reporting_period" ? "出现新报告期" : "指标穿越阈值"}</option>)}</select><small>{selected?.kind === "period_advanced" ? "报告期推进可转换为新报告期或阈值草案。" : "只有报告期推进可转换为新报告期草案。"}</small></label>
        {template === "metric_threshold_crossing" && <div className="dossier-alert-dialog__predicate">
          <label><span>观察值</span><select value={field} disabled={busy} onChange={(event) => setField(event.currentTarget.value as DossierAlertField)}>{fieldOptions.map((option) => <option key={option} value={option}>{option === "value" ? "指标值" : option.toUpperCase()}</option>)}</select><small>YoY / QoQ 只在本次 sealed Fact 实际包含对应 comparison 时可选。</small></label>
          <label><span>条件</span><select value={operator} disabled={busy} onChange={(event) => setOperator(event.currentTarget.value as typeof operator)}><option value="crosses_above">向上穿越</option><option value="crosses_below">向下穿越</option></select></label>
          <label><span>阈值</span><input value={threshold} disabled={busy} inputMode="decimal" placeholder="严格十进制，例如 0.15" aria-invalid={threshold.length > 0 && !thresholdValid} onChange={(event) => setThreshold(event.currentTarget.value.trim())} /><small>{threshold.length > 0 && !thresholdValid ? "请输入不含百分号或指数的十进制数。" : "YoY / QoQ 使用 ratio，例如 0.15 表示 15%。"}</small></label>
        </div>}
        {error && <p className="dossier-alert-dialog__error" role="status">{error}</p>}
        <footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="dossier-action--primary" disabled={busy || !canSubmit}>{busy ? "正在创建" : "建立草案"}</button></footer>
      </form>}
    </div>
  </div>;
}

export function DossierInspectorPanel({ view, loading, error, dossier = null, revision = null, sourceRun = null, alertDrafts = [], alertDraftsLoading = false, alertDraftsError = null, busyAction = null, purgeConfirmationOpen = false, onCreateThesisProposal = async () => { throw new Error("Thesis proposal 暂不可用"); }, onConfirmThesisProposal = async () => undefined, onRequestPurge = () => undefined, onCancelPurge = () => undefined, onConfirmPurge = async () => undefined }: {
  view: DossierProjectionView | null;
  loading: boolean;
  error: string | null;
  dossier?: ResearchDossier | null;
  revision?: ResearchDossierRevision | null;
  sourceRun?: ResearchDossierSourceRun | null;
  alertDrafts?: AlertRuleDraft[];
  alertDraftsLoading?: boolean;
  alertDraftsError?: string | null;
  busyAction?: DossierAction;
  purgeConfirmationOpen?: boolean;
  onCreateThesisProposal?(operation: ManualThesisOperation): Promise<ResearchDossierProposal>;
  onConfirmThesisProposal?(proposal: ResearchDossierProposal): Promise<void>;
  onRequestPurge?(): void;
  onCancelPurge?(): void;
  onConfirmPurge?(): Promise<void>;
}) {
  const hasLongTermDossier = Boolean(dossier && revision);
  if (loading && !view && !hasLongTermDossier) return <p className="agent-inspector-empty">正在读取本次 Run 的 Dossier projection。</p>;
  if (error && !view && !hasLongTermDossier) return <p className="agent-inspector-error" role="status">{error}</p>;
  if (!view && !hasLongTermDossier) return <p className="agent-inspector-empty">这条 Run 没有 Dossier projection；历史 Run 不会补做投影。</p>;

  const projection = view?.projection ?? null;
  const proposal = view?.proposal ?? null;
  return <section className="agent-inspector-panel dossier-inspector">
    <h3>Research Dossier</h3>
    {!view && <p className="agent-inspector-empty">这条 Run 没有 Dossier projection；历史 Run 不会补做投影。</p>}
    {error && <p className="agent-inspector-error" role="status">{error}</p>}
    {projection && proposal && <>
      <dl>
        <InspectorValue label="Proposal" value={`${proposal.id} · ${proposal.status}`} />
        <InspectorValue label="Instrument" value={projection.instrumentId} />
        <InspectorValue label="Base revision" value={projection.base.revisionId ?? "首次基线"} />
        <InspectorValue label="Dossier version" value={String(projection.base.dossierVersion)} />
        <InspectorValue label="Observation cutoff" value={projection.observationCutoff} />
        <InspectorValue label="Knowledge cutoff" value={projection.knowledgeCutoff} />
        <InspectorValue label="Evidence fingerprint" value={projection.sourceEvidenceFingerprint} />
        <InspectorValue label="Research fingerprint" value={projection.researchFingerprint} />
        <InspectorValue label="Projection fingerprint" value={projection.fingerprint} />
        <InspectorValue label="Delta engine" value={projection.provenance.factDeltaEngineVersion} />
        <InspectorValue label="Thesis source" value={projection.provenance.thesisImpactSource} />
      </dl>
      <div className="dossier-inspector__facts">{projection.factDeltas.map((delta) => <article key={delta.id}><header><strong>{metricLabel(delta.current.metric)}</strong><span>{deltaKindLabel(delta.kind)} · {delta.current.quality.reliable ? "可靠" : "未验证"}</span></header><p>{formatDecimal(delta.current.value.decimal, delta.current.value.unit)} · {formatPeriod(delta.current)}</p><details><summary>公式与 provenance</summary><dl><InspectorValue label="Fact ID" value={delta.current.factId} /><InspectorValue label="Evidence ID" value={delta.current.evidenceId} /><InspectorValue label="Formula" value={delta.current.formula ? `${delta.current.formula.id}@${delta.current.formula.version} · ${delta.current.formula.expression}` : "来源原值"} /><InspectorValue label="Providers" value={delta.current.provenance.providers.join("、")} /><InspectorValue label="Source artifacts" value={delta.current.provenance.sourceArtifactIds.join("、")} /><InspectorValue label="Source as-of" value={delta.current.provenance.sourceAsOf} /></dl></details></article>)}</div>
    </>}
    {dossier && revision && <section className="dossier-inspector__confirmed">
      <header><h4>已确认长期档案</h4><span>revision {revision.revisionNumber}</span></header>
      <dl>
        <InspectorValue label="Dossier" value={dossier.id} />
        <InspectorValue label="Current revision" value={revision.id} />
        <InspectorValue label="Observation cutoff" value={revision.observationCutoff} />
        <InspectorValue label="Knowledge cutoff" value={revision.knowledgeCutoff} />
        <InspectorValue label="Revision fingerprint" value={revision.fingerprint} />
        <InspectorValue label="Source Run" value={sourceRun ? `${sourceRun.runId} · ${sourceRun.available ? "可用" : "已清理"}` : "未关联（例如手动 Thesis revision）"} />
      </dl>
      {sourceRun && !sourceRun.available && <p className="dossier-inspector__source-unavailable" role="status">来源 Run 已清理，原 Run 正文与 Evidence 已不可用；已确认 Dossier revision 仍独立保留。</p>}
      <DossierRevisionFacts revision={revision} />
      <ThesisEditor revision={revision} busy={busyAction === "thesis"} onCreate={onCreateThesisProposal} onConfirm={onConfirmThesisProposal} />
      <DossierPrivacyControl open={purgeConfirmationOpen} busy={busyAction === "purge"} onRequest={onRequestPurge} onCancel={onCancelPurge} onConfirm={onConfirmPurge} />
    </section>}
    <AlertDraftList drafts={alertDrafts} loading={alertDraftsLoading} error={alertDraftsError} />
    <p className="agent-inspector-boundary">Projection 不是事实来源。数字、公式与 provenance 仍以封存 Evidence 为准；已确认档案独立于 Run 保留，来源 Run 按保留策略清理后不自动删除 Dossier。</p>
  </section>;
}

function DossierRevisionFacts({ revision }: { revision: ResearchDossierRevision }) {
  return <section className="dossier-inspector__revision-facts" aria-label="Dossier revision facts">
    <DossierRevisionFactGroup title="Confirmed Fact Anchors" facts={revision.factAnchors} empty="这个 revision 没有 confirmed Fact Anchor。" />
    <DossierRevisionFactGroup title="Unverified observations" facts={revision.unverifiedObservations} empty="这个 revision 没有未验证观察。" />
  </section>;
}

function DossierRevisionFactGroup({ title, facts, empty }: { title: string; facts: DossierFactAnchor[]; empty: string }) {
  return <section className="dossier-inspector__revision-fact-group">
    <header><h5>{title}</h5><span>{facts.length}</span></header>
    {facts.length ? <div>{facts.map((fact) => <DossierAnchorAuditCard key={fact.id} fact={fact} />)}</div> : <p>{empty}</p>}
  </section>;
}

function DossierAnchorAuditCard({ fact }: { fact: DossierFactAnchor }) {
  return <article data-reliable={fact.quality.reliable}>
    <header><div><strong>{metricLabel(fact.metric)}</strong><span>{formatPeriod(fact)}</span></div><small>{fact.quality.status} · {fact.quality.reliable ? "reliable" : "unverified"}</small></header>
    <p>{formatDecimal(fact.value.decimal, fact.value.unit)} <small>{unitLabel(fact.value.unit)}</small></p>
    <dl>
      <InspectorValue label="Formula" value={fact.formula ? `${fact.formula.id}@${fact.formula.version} · ${fact.formula.expression}` : "来源原值"} />
      <InspectorValue label="Evidence ID" value={fact.evidenceId} />
      <InspectorValue label="Providers" value={fact.provenance.providers.join("、")} />
      <InspectorValue label="Source artifacts" value={fact.provenance.sourceArtifactIds.join("、")} />
      <InspectorValue label="Source as-of" value={fact.provenance.sourceAsOf} />
      <InspectorValue label="Research fingerprint" value={fact.researchFingerprint} />
      <InspectorValue label="Quality coverage" value={`${fact.quality.coverage.actual}/${fact.quality.coverage.required}`} />
      <InspectorValue label="Quality warnings" value={fact.quality.warnings.join("、") || "无"} />
    </dl>
  </article>;
}

function DossierPrivacyControl({ open, busy, onRequest, onCancel, onConfirm }: { open: boolean; busy: boolean; onRequest(): void; onCancel(): void; onConfirm(): Promise<void> }) {
  return <section className="dossier-inspector__privacy" aria-label="Research Dossier 隐私删除">
    <header><div><h4>长期记录隐私</h4><p>此操作与清除单条 Run 正文相互独立。</p></div>{!open && <button type="button" onClick={onRequest} disabled={busy}>删除长期研究档案</button>}</header>
    {open && <aside role="alert"><div><strong>确认永久删除</strong><p>此操作不可恢复，将级联删除 revisions、proposals 与 Alert drafts；仅保留无正文审计墓碑。</p></div><div><button type="button" onClick={onCancel} disabled={busy}>取消</button><button type="button" className="dossier-inspector__purge-confirm" onClick={() => void onConfirm().catch(() => undefined)} disabled={busy}>{busy ? "正在删除" : "确认永久删除"}</button></div></aside>}
  </section>;
}

function ThesisEditor({ revision, busy, onCreate, onConfirm }: { revision: ResearchDossierRevision; busy: boolean; onCreate(operation: ManualThesisOperation): Promise<ResearchDossierProposal>; onConfirm(proposal: ResearchDossierProposal): Promise<void> }) {
  const [operation, setOperation] = useState<ManualThesisOperation>({ operation: "create", text: "" });
  const [pending, setPending] = useState<ResearchDossierProposal | null>(null);
  const [issue, setIssue] = useState<string | null>(null);
  const text = "text" in operation ? operation.text : "";
  const choose = (next: ManualThesisOperation) => { setOperation(next); setPending(null); setIssue(null); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); setIssue(null);
    try { setPending(await onCreate(operation)); } catch (cause) { setIssue(cause instanceof Error ? cause.message : "Thesis proposal 创建失败"); }
  };
  return <section className="dossier-inspector__theses"><header><h4>用户 Thesis</h4><span>模型不能改写</span></header><div className="dossier-inspector__thesis-list">{revision.theses.map((thesis) => <article key={thesis.id}><strong>{thesis.text}</strong><small>{thesis.status} · revision {thesis.revision}</small><div><button type="button" onClick={() => choose({ operation: "revise", thesisId: thesis.id, text: thesis.text })}>修订</button><button type="button" onClick={() => choose({ operation: "invalidate", thesisId: thesis.id })}>标记失效</button><button type="button" onClick={() => choose({ operation: "retire", thesisId: thesis.id })}>退休</button></div></article>)}</div><form onSubmit={(event) => void submit(event)}><header><strong>{operation.operation === "create" ? "新建 Thesis" : `准备${thesisOperationLabel(operation.operation)}`}</strong>{operation.operation !== "create" && <button type="button" onClick={() => choose({ operation: "create", text: "" })}>返回新建</button>}</header>{(operation.operation === "create" || operation.operation === "revise") && <label><span>Thesis 内容</span><textarea value={text} maxLength={800} disabled={busy} onChange={(event) => setOperation(operation.operation === "create" ? { operation: "create", text: event.currentTarget.value } : { ...operation, text: event.currentTarget.value })} /><small>只保存用户输入；模型不会补写或改写。</small></label>}<button type="submit" disabled={busy || ((operation.operation === "create" || operation.operation === "revise") && !text.trim())}>生成修改 proposal</button></form>{pending && <div className="dossier-inspector__thesis-confirm" role="status"><strong>Proposal 已形成，尚未写入 Dossier</strong><p>{manualThesisSummary(pending)}</p><button type="button" onClick={() => void onConfirm(pending).then(() => setPending(null)).catch((cause) => setIssue(cause instanceof Error ? cause.message : "Thesis proposal 确认失败"))} disabled={busy}>确认更新 Thesis</button></div>}{issue && <p className="agent-inspector-error" role="status">{issue}</p>}</section>;
}

function AlertDraftList({ drafts, loading, error }: { drafts: AlertRuleDraft[]; loading: boolean; error: string | null }) {
  return <section className="dossier-inspector__alerts"><header><h4>Alert Rule Drafts</h4><span>尚未激活</span></header>{loading ? <p>正在读取草案。</p> : error ? <p className="agent-inspector-error">{error}</p> : drafts.length ? <div>{drafts.map((draft) => <article key={draft.id}><strong>{alertPredicateLabel(draft)}</strong><small>{Date.parse(draft.expiresAt) <= Date.now() ? "已过期" : "draft"} · 到期 {shortDate(draft.expiresAt)}</small><code>{draft.id}</code></article>)}</div> : <p>当前 profile 没有 inert Alert 草案。</p>}</section>;
}

function InspectorValue({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function formatDecimal(decimal: string, unit: DossierFactAnchor["value"]["unit"]): string {
  if (unit === "ratio") return formatRatio(decimal);
  const [integer, fraction] = decimal.split(".");
  const sign = integer?.startsWith("-") ? "-" : "";
  const digits = integer?.replace(/^-/, "") ?? "0";
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}${fraction ? `.${fraction}` : ""}`;
}

export function formatDossierRatio(decimal: string): string {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(decimal)) return decimal;
  const negative = decimal.startsWith("-");
  const unsigned = negative ? decimal.slice(1) : decimal;
  const [integer = "0", fraction = ""] = unsigned.split(".");
  const digits = `${integer}${fraction}`;
  const shiftedIndex = integer.length + 2;
  const shifted = shiftedIndex >= digits.length
    ? `${digits}${"0".repeat(shiftedIndex - digits.length)}`
    : `${digits.slice(0, shiftedIndex)}.${digits.slice(shiftedIndex)}`;
  const [shiftedInteger = "0", shiftedFraction = ""] = shifted.split(".");
  const normalizedInteger = shiftedInteger.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = shiftedFraction.replace(/0+$/, "");
  const normalized = normalizedFraction ? `${normalizedInteger}.${normalizedFraction}` : normalizedInteger;
  return `${negative && normalized !== "0" ? "-" : ""}${normalized}%`;
}

export function isDossierThresholdDecimal(value: string): boolean {
  return value !== "-0" && /^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(value) && value.length <= 80;
}

function formatRatio(decimal: string): string { return formatDossierRatio(decimal); }

function formatPeriod(anchor: DossierFactAnchor): string {
  return `${shortDate(anchor.period.start)} — ${shortDate(anchor.period.end)} · ${basisLabel(anchor.period.basis)}`;
}

function shortDate(value: string): string { return value.slice(0, 10); }
function basisLabel(value: DossierFactAnchor["period"]["basis"]): string { return ({ quarter: "单季度", year_to_date: "年内累计", fiscal_year: "财年", point_in_time: "期末值" } as const)[value]; }
function unitLabel(value: DossierFactAnchor["value"]["unit"]): string { return ({ CNY: "人民币", ratio: "比率", shares: "股" } as const)[value]; }
function metricLabel(value: DossierFactAnchor["metric"]): string { return ({ operating_revenue: "营业收入", operating_profit: "营业利润", net_profit_attributable_to_parent: "归母净利润", net_cash_flow_from_operating_activities: "经营活动现金流", total_assets: "总资产" } as const)[value]; }
function deltaKindLabel(value: DossierFactDelta["kind"]): string { return ({ baseline_added: "新增基线", period_advanced: "报告期推进", source_revised: "来源修订", quality_changed: "质量变化" } as const)[value]; }
function thesisImpactLabel(value: ThesisImpact["impact"]): string { return ({ supports: "支持", weakens: "削弱", invalidates: "可能失效", mixed: "影响混合", insufficient_evidence: "证据不足" } as const)[value]; }
function proposalStatusLabel(value: DossierProposalStatus): string { return ({ pending: "待确认", confirmed: "已确认", dismissed: "暂不处理", expired: "已过期", stale: "需重新投影" } as const)[value]; }
function thesisOperationLabel(value: ManualThesisOperation["operation"]): string { return ({ create: "新建", revise: "修订", invalidate: "标记失效", retire: "退休" } as const)[value]; }
function manualThesisSummary(proposal: ResearchDossierProposal): string { return proposal.kind === "manual_thesis" && proposal.payload ? thesisOperationLabel(proposal.payload.operation) : "Thesis 修改"; }
function alertPredicateLabel(draft: AlertRuleDraft): string { return draft.predicate.template === "new_reporting_period" ? `${metricLabel(draft.predicate.metric)} · 新报告期` : `${metricLabel(draft.predicate.metric)} · ${draft.predicate.field.toUpperCase()} ${draft.predicate.operator === "crosses_above" ? "向上穿越" : "向下穿越"} ${draft.predicate.threshold.decimal}`; }
