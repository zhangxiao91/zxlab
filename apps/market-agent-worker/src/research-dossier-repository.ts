import {
  ALERT_RULE_DRAFT_SCHEMA_VERSION,
  DOSSIER_PROPOSAL_SCHEMA_VERSION,
  RESEARCH_DOSSIER_REVISION_SCHEMA_VERSION,
  RESEARCH_DOSSIER_SCHEMA_VERSION,
  calculateAlertRuleDraftFingerprint,
  calculateResearchDossierRevisionFingerprint,
  isAlertRuleDraft,
  isResearchDossier,
  isResearchDossierRevision,
  isResearchDossierProposal,
  isResearchDossierProjection,
  validateDossierConfirmIntent,
  validateDossierDismissIntent,
  validateManualThesisProposalIntent,
  validateAlertRuleDraftIntent,
  verifyResearchDossierProjectionFingerprint,
  verifyResearchDossierRevisionFingerprint,
  verifyAlertRuleDraftFingerprint,
  type AlertRuleDraft,
  type AlertRuleDraftIntent,
  type DossierConfirmIntent,
  type DossierDismissIntent,
  type DossierFactAnchor,
  type ManualThesisProposalIntent,
  type ResearchDossier,
  type ResearchDossierProjection,
  type ResearchDossierProposal,
  type ResearchDossierRevision,
  type ThesisAssessment,
} from "@zxlab/market-agent-schema";

export interface DossierWithRevision { dossier: ResearchDossier; revision: ResearchDossierRevision; }
export interface DossierConfirmResult extends DossierWithRevision { proposal: ResearchDossierProposal; reused: boolean; }
export interface DossierPurgeIntent { confirmation: "DELETE_RESEARCH_DOSSIER"; idempotencyKey: string; }
const MAX_DOSSIER_REVISION_CHAIN_LENGTH = 1_000;

export interface ResearchDossierRepository {
  getProjectionByRun(runId: string, profileId: string): Promise<ResearchDossierProposal | null>;
  getProposal(proposalId: string, profileId: string): Promise<ResearchDossierProposal | null>;
  saveProjection(projection: ResearchDossierProjection, expiresAt: string): Promise<{ proposal: ResearchDossierProposal; created: boolean }>;
  saveRebasedProjection(projection: ResearchDossierProjection, expiresAt: string, idempotencyKey: string): Promise<{ proposal: ResearchDossierProposal; created: boolean }>;
  getDossier(profileId: string, instrumentId: string): Promise<DossierWithRevision | null>;
  getRevision(profileId: string, revisionId: string): Promise<ResearchDossierRevision | null>;
  confirm(proposalId: string, profileId: string, intent: DossierConfirmIntent, confirmedAt: string): Promise<DossierConfirmResult>;
  dismiss(proposalId: string, profileId: string, intent: DossierDismissIntent, dismissedAt: string): Promise<{ proposal: ResearchDossierProposal; reused: boolean }>;
  createManualThesisProposal(profileId: string, instrumentId: string, intent: ManualThesisProposalIntent, createdAt: string, expiresAt: string): Promise<{ proposal: ResearchDossierProposal; created: boolean }>;
  createAlertRuleDraft(proposalId: string, profileId: string, intent: AlertRuleDraftIntent, createdAt: string): Promise<{ draft: AlertRuleDraft; reused: boolean }>;
  listAlertRuleDrafts(profileId: string): Promise<AlertRuleDraft[]>;
  sweepRetention(now: string): Promise<{ expiredProposals: number; purgedProposalPayloads: number; expiredAlertDrafts: number }>;
  purgeDossier(profileId: string, instrumentId: string, intent: DossierPurgeIntent, purgedAt: string): Promise<{ purged: true; reused: boolean }>;
}

export class MemoryResearchDossierRepository implements ResearchDossierRepository {
  private readonly proposals = new Map<string, ResearchDossierProposal>();
  private readonly proposalByRun = new Map<string, string[]>();
  private readonly dossiers = new Map<string, ResearchDossier>();
  private readonly revisions = new Map<string, ResearchDossierRevision>();
  private readonly commands = new Map<string, { hash: string; result: DossierConfirmResult }>();
  private readonly dismissCommands = new Map<string, { hash: string; proposal?: ResearchDossierProposal }>();
  private readonly manualCommands = new Map<string, { hash: string; proposal?: ResearchDossierProposal }>();
  private readonly alertCommands = new Map<string, { hash: string; draft?: AlertRuleDraft }>();
  private readonly alertDrafts = new Map<string, AlertRuleDraft>();
  private readonly rebaseCommands = new Map<string, { hash: string; result?: { proposal: ResearchDossierProposal; created: boolean } }>();
  private readonly purgeCommands = new Map<string, { hash: string }>();

  async getProjectionByRun(runId: string, profileId: string): Promise<ResearchDossierProposal | null> {
    const ids = this.proposalByRun.get(runKey(runId, profileId)) ?? [];
    const proposal = ids.length > 0 ? this.proposals.get(ids[ids.length - 1]!) : undefined;
    return proposal?.profileId === profileId ? structuredClone(proposal) : null;
  }

  async getProposal(proposalId: string, profileId: string): Promise<ResearchDossierProposal | null> {
    const proposal = this.proposals.get(proposalId);
    return proposal?.profileId === profileId ? structuredClone(proposal) : null;
  }

  async saveProjection(projection: ResearchDossierProjection, expiresAt: string): Promise<{ proposal: ResearchDossierProposal; created: boolean }> {
    if (!isResearchDossierProjection(projection) || !await verifyResearchDossierProjectionFingerprint(projection)) throw new Error("DOSSIER_PROJECTION_INTEGRITY_FAILURE");
    assertExpiry(projection.projectedAt, expiresAt);
    const key = runKey(projection.sourceRunId, projection.profileId);
    const prior = (this.proposalByRun.get(key) ?? []).map((id) => this.proposals.get(id)).find((item) => item?.base.dossierVersion === projection.base.dossierVersion && item.base.dossierFingerprint === projection.base.dossierFingerprint);
    if (prior) {
      if (prior.kind !== "projection" || prior.payloadFingerprint !== projection.fingerprint) throw new Error("DOSSIER_PROJECTION_CONFLICT");
      return { proposal: structuredClone(prior), created: false };
    }
    const current = this.dossiers.get(dossierKey(projection.profileId, projection.instrumentId));
    if (!baseMatchesDossier(projection, current)) throw new Error("DOSSIER_REVISION_CONFLICT");
    const proposal: ResearchDossierProposal = {
      schemaVersion: DOSSIER_PROPOSAL_SCHEMA_VERSION,
      id: await resourceId("dossier-proposal", projection.profileId, projection.instrumentId, `${projection.sourceRunId}:${projection.base.dossierVersion}:${projection.base.dossierFingerprint ?? "none"}`),
      kind: "projection",
      profileId: projection.profileId,
      instrumentId: projection.instrumentId,
      dossierId: projection.base.dossierId,
      base: structuredClone(projection.base),
      sourceRunId: projection.sourceRunId,
      payload: structuredClone(projection),
      payloadFingerprint: projection.fingerprint,
      status: "pending",
      createdAt: projection.projectedAt,
      updatedAt: projection.projectedAt,
      expiresAt,
    };
    if (!isResearchDossierProposal(proposal)) throw new Error("DOSSIER_PROPOSAL_INTEGRITY_FAILURE");
    this.proposals.set(proposal.id, proposal);
    this.proposalByRun.set(key, [...(this.proposalByRun.get(key) ?? []), proposal.id]);
    return { proposal: structuredClone(proposal), created: true };
  }

  async saveRebasedProjection(projection: ResearchDossierProjection, expiresAt: string, idempotencyKey: string): Promise<{ proposal: ResearchDossierProposal; created: boolean }> {
    if (!validIdempotencyKey(idempotencyKey)) throw new Error("DOSSIER_REBASE_INVALID");
    const hash = await rebaseRequestHash(projection);
    const key = `${projection.profileId}:${idempotencyKey}`;
    const prior = this.rebaseCommands.get(key);
    if (prior) {
      if (prior.hash !== hash) throw new Error("DOSSIER_IDEMPOTENCY_CONFLICT");
      if (!prior.result) throw new Error("DOSSIER_COMMAND_RESULT_PURGED");
      return structuredClone({ ...prior.result, created: false });
    }
    const result = await this.saveProjection(projection, expiresAt);
    this.rebaseCommands.set(key, { hash, result });
    return result;
  }

  async getDossier(profileId: string, instrumentId: string): Promise<DossierWithRevision | null> {
    const dossier = this.dossiers.get(dossierKey(profileId, instrumentId));
    if (!dossier || dossier.profileId !== profileId) return null;
    const revision = await verifyCompleteRevisionChain(dossier, async (revisionId) => this.revisions.get(revisionId) ?? null);
    return structuredClone({ dossier, revision });
  }

  async getRevision(profileId: string, revisionId: string): Promise<ResearchDossierRevision | null> {
    const revision = this.revisions.get(revisionId);
    if (!revision || revision.profileId !== profileId) return null;
    if (!await verifyResearchDossierRevisionFingerprint(revision)) throw new Error("DOSSIER_INTEGRITY_FAILURE");
    return structuredClone(revision);
  }

  async confirm(proposalId: string, profileId: string, intent: DossierConfirmIntent, confirmedAt: string): Promise<DossierConfirmResult> {
    if (validateDossierConfirmIntent(intent).length > 0 || !isCanonicalIso(confirmedAt)) throw new Error("DOSSIER_CONFIRM_INVALID");
    const commandHash = await calculateCommandHash({ proposalId, profileId, intent });
    const commandKey = `${profileId}:${intent.idempotencyKey}`;
    const priorCommand = this.commands.get(commandKey);
    if (priorCommand) {
      if (priorCommand.hash !== commandHash) throw new Error("DOSSIER_IDEMPOTENCY_CONFLICT");
      return structuredClone({ ...priorCommand.result, reused: true });
    }
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.profileId !== profileId) throw new Error("DOSSIER_PROPOSAL_NOT_FOUND");
    if (!isResearchDossierProposal(proposal) || !proposal.payload) throw new Error("DOSSIER_INTEGRITY_FAILURE");
    if (proposal.status === "expired" || Date.parse(confirmedAt) >= Date.parse(proposal.expiresAt)) throw new Error("DOSSIER_PROPOSAL_EXPIRED");
    if (proposal.status !== "pending") throw new Error("DOSSIER_PROPOSAL_NOT_PENDING");
    if (intent.expectedDossierVersion !== proposal.base.dossierVersion) throw new Error("DOSSIER_REVISION_CONFLICT");

    const current = this.dossiers.get(dossierKey(profileId, proposal.instrumentId));
    if (!baseMatchesProposal(proposal, current)) throw new Error("DOSSIER_REVISION_CONFLICT");
    const revision = await applyProposal(proposal, current ? this.revisions.get(current.currentRevisionId) ?? null : null, intent, confirmedAt);
    const dossier: ResearchDossier = current ? {
      ...current,
      currentRevisionId: revision.id,
      currentRevisionFingerprint: revision.fingerprint,
      version: current.version + 1,
      updatedAt: confirmedAt,
    } : {
      schemaVersion: RESEARCH_DOSSIER_SCHEMA_VERSION,
      id: revision.dossierId,
      profileId,
      instrumentId: proposal.instrumentId,
      currentRevisionId: revision.id,
      version: 1,
      currentRevisionFingerprint: revision.fingerprint,
      createdAt: confirmedAt,
      updatedAt: confirmedAt,
    };
    const confirmedProposal: ResearchDossierProposal = { ...proposal, status: "confirmed", updatedAt: confirmedAt };
    // The proposal base deliberately retains null dossier identity for the first baseline.
    this.revisions.set(revision.id, revision);
    this.dossiers.set(dossierKey(profileId, proposal.instrumentId), dossier);
    this.proposals.set(proposal.id, confirmedProposal);
    const result: DossierConfirmResult = { dossier: structuredClone(dossier), revision: structuredClone(revision), proposal: structuredClone(confirmedProposal), reused: false };
    this.commands.set(commandKey, { hash: commandHash, result });
    return structuredClone(result);
  }

  async dismiss(proposalId: string, profileId: string, intent: DossierDismissIntent, dismissedAt: string): Promise<{ proposal: ResearchDossierProposal; reused: boolean }> {
    if (validateDossierDismissIntent(intent).length > 0 || !isCanonicalIso(dismissedAt)) throw new Error("DOSSIER_DISMISS_INVALID");
    const hash = await calculateCommandHash({ proposalId, profileId, intent });
    const key = `${profileId}:${intent.idempotencyKey}`;
    const prior = this.dismissCommands.get(key);
    if (prior) {
      if (prior.hash !== hash) throw new Error("DOSSIER_IDEMPOTENCY_CONFLICT");
      if (!prior.proposal) throw new Error("DOSSIER_COMMAND_RESULT_PURGED");
      return { proposal: structuredClone(prior.proposal), reused: true };
    }
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.profileId !== profileId) throw new Error("DOSSIER_PROPOSAL_NOT_FOUND");
    if (proposal.status !== "pending") throw new Error("DOSSIER_PROPOSAL_NOT_PENDING");
    const dismissed: ResearchDossierProposal = { ...proposal, status: "dismissed", updatedAt: dismissedAt };
    this.proposals.set(proposalId, dismissed);
    this.dismissCommands.set(key, { hash, proposal: dismissed });
    return { proposal: structuredClone(dismissed), reused: false };
  }

  async createManualThesisProposal(profileId: string, instrumentId: string, intent: ManualThesisProposalIntent, createdAt: string, expiresAt: string): Promise<{ proposal: ResearchDossierProposal; created: boolean }> {
    if (validateManualThesisProposalIntent(intent).length > 0 || !isCanonicalIso(createdAt)) throw new Error("DOSSIER_THESIS_INTENT_INVALID");
    assertExpiry(createdAt, expiresAt);
    const hash = await calculateCommandHash({ profileId, instrumentId, intent });
    const commandKey = `${profileId}:${intent.idempotencyKey}`;
    const prior = this.manualCommands.get(commandKey);
    if (prior) {
      if (prior.hash !== hash) throw new Error("DOSSIER_IDEMPOTENCY_CONFLICT");
      if (!prior.proposal) throw new Error("DOSSIER_COMMAND_RESULT_PURGED");
      return { proposal: structuredClone(prior.proposal), created: false };
    }
    const state = await this.getDossier(profileId, instrumentId);
    if (!state || state.dossier.version !== intent.expectedDossierVersion) throw new Error("DOSSIER_REVISION_CONFLICT");
    const { expectedDossierVersion: _version, idempotencyKey: _key, ...operation } = intent;
    const payloadFingerprint = await calculateCommandHash(operation);
    const proposal: ResearchDossierProposal = {
      schemaVersion: DOSSIER_PROPOSAL_SCHEMA_VERSION,
      id: await resourceId("dossier-proposal", profileId, instrumentId, `manual:${intent.idempotencyKey}`),
      kind: "manual_thesis",
      profileId,
      instrumentId,
      dossierId: state.dossier.id,
      base: { schemaVersion: "dossier-base-receipt.v1", profileId, instrumentId, dossierId: state.dossier.id, revisionId: state.revision.id, dossierVersion: state.dossier.version, dossierFingerprint: state.revision.fingerprint },
      sourceRunId: null,
      payload: operation,
      payloadFingerprint,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      expiresAt,
    };
    if (!isResearchDossierProposal(proposal)) throw new Error("DOSSIER_PROPOSAL_INTEGRITY_FAILURE");
    this.proposals.set(proposal.id, proposal);
    this.manualCommands.set(commandKey, { hash, proposal });
    return { proposal: structuredClone(proposal), created: true };
  }

  async createAlertRuleDraft(proposalId: string, profileId: string, intent: AlertRuleDraftIntent, createdAt: string): Promise<{ draft: AlertRuleDraft; reused: boolean }> {
    if (validateAlertRuleDraftIntent(intent).length > 0 || !isCanonicalIso(createdAt)) throw new Error("ALERT_DRAFT_INTENT_INVALID");
    const hash = await calculateCommandHash({ proposalId, profileId, intent });
    const commandKey = `${profileId}:${intent.idempotencyKey}`;
    const prior = this.alertCommands.get(commandKey);
    if (prior) {
      if (prior.hash !== hash) throw new Error("DOSSIER_IDEMPOTENCY_CONFLICT");
      if (!prior.draft) throw new Error("DOSSIER_PROPOSAL_NOT_FOUND");
      return { draft: structuredClone(prior.draft), reused: true };
    }
    const proposal = this.proposals.get(proposalId);
    if (!proposal || proposal.profileId !== profileId || proposal.kind !== "projection") throw new Error("DOSSIER_PROPOSAL_NOT_FOUND");
    assertProposalAllowsAlert(proposal, createdAt);
    if (!proposal.payload) throw new Error("DOSSIER_INTEGRITY_FAILURE");
    if (!await verifyResearchDossierProjectionFingerprint(proposal.payload)) throw new Error("DOSSIER_INTEGRITY_FAILURE");
    const delta = proposal.payload.factDeltas.find((item) => item.id === intent.deltaId);
    if (!delta) throw new Error("ALERT_DRAFT_DELTA_NOT_FOUND");
    if (intent.template === "new_reporting_period" && delta.kind !== "period_advanced") throw new Error("ALERT_DRAFT_TEMPLATE_MISMATCH");
    if (!delta.current.quality.reliable) throw new Error("ALERT_DRAFT_RELIABLE_FACT_REQUIRED");
    const predicate = intent.template === "new_reporting_period"
      ? { version: "financial-alert-predicate.v1" as const, template: "new_reporting_period" as const, metric: delta.current.metric, baselinePeriod: structuredClone(delta.current.period) }
      : {
        version: "financial-alert-predicate.v1" as const,
        template: "metric_threshold_crossing" as const,
        metric: delta.current.metric,
        baselinePeriod: structuredClone(delta.current.period),
        field: intent.field,
        operator: intent.operator,
        threshold: { decimal: intent.threshold, unit: comparisonUnit(delta.current, intent.field) },
      };
    const expiresAt = new Date(Date.parse(createdAt) + 30 * 24 * 60 * 60 * 1_000).toISOString();
    const unsigned: Omit<AlertRuleDraft, "fingerprint"> = {
      schemaVersion: ALERT_RULE_DRAFT_SCHEMA_VERSION,
      id: await resourceId("alert-draft", profileId, proposal.instrumentId, intent.idempotencyKey),
      profileId,
      instrumentId: proposal.instrumentId,
      sourceProposalId: proposal.id,
      sourceProjectionFingerprint: proposal.payload.fingerprint,
      sourceDeltaId: delta.id,
      sourceEvidenceIds: [delta.current.evidenceId],
      researchFingerprint: proposal.payload.researchFingerprint,
      predicate,
      requiresReliableFacts: true,
      status: "draft",
      createdAt,
      expiresAt,
    };
    const draft: AlertRuleDraft = { ...unsigned, fingerprint: await calculateAlertRuleDraftFingerprint(unsigned) };
    this.alertDrafts.set(draft.id, draft);
    this.alertCommands.set(commandKey, { hash, draft });
    return { draft: structuredClone(draft), reused: false };
  }

  async listAlertRuleDrafts(profileId: string): Promise<AlertRuleDraft[]> {
    return [...this.alertDrafts.values()].filter((draft) => draft.profileId === profileId).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((draft) => structuredClone(draft));
  }

  async sweepRetention(now: string): Promise<{ expiredProposals: number; purgedProposalPayloads: number; expiredAlertDrafts: number }> {
    if (!isCanonicalIso(now)) throw new Error("DOSSIER_RETENTION_TIME_INVALID");
    let expiredProposals = 0;
    let purgedProposalPayloads = 0;
    let expiredAlertDrafts = 0;
    const purgeBefore = Date.parse(now) - 90 * 24 * 60 * 60 * 1_000;
    for (const [id, proposal] of this.proposals) {
      let next = proposal;
      if (proposal.status === "pending" && Date.parse(proposal.expiresAt) <= Date.parse(now)) { next = { ...proposal, status: "expired", updatedAt: now }; expiredProposals += 1; }
      if (["dismissed", "expired", "stale"].includes(next.status) && next.payload && Date.parse(next.updatedAt) <= purgeBefore) {
        next = { ...next, payload: null };
        purgedProposalPayloads += 1;
        clearMemoryCommandBodiesForProposal(this.dismissCommands, this.manualCommands, this.rebaseCommands, id);
      }
      this.proposals.set(id, next);
    }
    for (const [id, draft] of this.alertDrafts) if (Date.parse(draft.expiresAt) <= Date.parse(now)) {
      this.alertDrafts.delete(id);
      for (const [key, command] of this.alertCommands) if (command.draft?.id === id) this.alertCommands.set(key, { hash: command.hash });
      expiredAlertDrafts += 1;
    }
    return { expiredProposals, purgedProposalPayloads, expiredAlertDrafts };
  }

  async purgeDossier(profileId: string, instrumentId: string, intent: DossierPurgeIntent, purgedAt: string): Promise<{ purged: true; reused: boolean }> {
    assertPurgeIntent(intent, purgedAt);
    const hash = await calculateCommandHash({ profileId, instrumentId, confirmation: intent.confirmation });
    const commandKey = `${profileId}:${intent.idempotencyKey}`;
    const prior = this.purgeCommands.get(commandKey);
    if (prior) {
      if (prior.hash !== hash) throw new Error("DOSSIER_IDEMPOTENCY_CONFLICT");
      return { purged: true, reused: true };
    }
    const key = dossierKey(profileId, instrumentId);
    const dossier = this.dossiers.get(key);
    if (!dossier) throw new Error("DOSSIER_NOT_FOUND");
    this.dossiers.delete(key);
    for (const [id, revision] of this.revisions) if (revision.dossierId === dossier.id && revision.profileId === profileId) this.revisions.delete(id);
    for (const [id, proposal] of this.proposals) if (proposal.profileId === profileId && proposal.instrumentId === instrumentId) this.proposals.delete(id);
    for (const [id, draft] of this.alertDrafts) if (draft.profileId === profileId && draft.instrumentId === instrumentId) this.alertDrafts.delete(id);
    for (const [id, result] of this.commands) if (result.result.dossier.profileId === profileId && result.result.dossier.instrumentId === instrumentId) this.commands.delete(id);
    for (const [id, result] of this.dismissCommands) if (result.proposal?.profileId === profileId && result.proposal.instrumentId === instrumentId) this.dismissCommands.delete(id);
    for (const [id, result] of this.manualCommands) if (result.proposal?.profileId === profileId && result.proposal.instrumentId === instrumentId) this.manualCommands.delete(id);
    for (const [id, result] of this.alertCommands) if (result.draft?.profileId === profileId && result.draft.instrumentId === instrumentId) this.alertCommands.delete(id);
    for (const [id, result] of this.rebaseCommands) if (result.result?.proposal.profileId === profileId && result.result.proposal.instrumentId === instrumentId) this.rebaseCommands.delete(id);
    this.purgeCommands.set(commandKey, { hash });
    return { purged: true, reused: false };
  }
}

export class D1ResearchDossierRepository implements ResearchDossierRepository {
  constructor(private readonly db: D1Database) {}

  async getProjectionByRun(runId: string, profileId: string): Promise<ResearchDossierProposal | null> {
    const row = await this.db.prepare("SELECT payload_json FROM research_dossier_proposals WHERE source_run_id = ? AND profile_id = ? AND kind = 'projection' ORDER BY created_at DESC LIMIT 1").bind(runId, profileId).first<{ payload_json: string }>();
    return row ? verifyProposal(parseProposalJson(row.payload_json)) : null;
  }

  async saveProjection(projection: ResearchDossierProjection, expiresAt: string): Promise<{ proposal: ResearchDossierProposal; created: boolean }> {
    if (!isResearchDossierProjection(projection) || !await verifyResearchDossierProjectionFingerprint(projection)) throw new Error("DOSSIER_PROJECTION_INTEGRITY_FAILURE");
    assertExpiry(projection.projectedAt, expiresAt);
    const baseKey = `${projection.base.dossierVersion}:${projection.base.dossierFingerprint ?? "none"}`;
    const existing = await this.db.prepare("SELECT payload_json FROM research_dossier_proposals WHERE source_run_id = ? AND profile_id = ? AND base_key = ?").bind(projection.sourceRunId, projection.profileId, baseKey).first<{ payload_json: string }>();
    if (existing) {
      const proposal = await verifyProposal(parseProposalJson(existing.payload_json));
      if (proposal.payloadFingerprint !== projection.fingerprint) throw new Error("DOSSIER_PROJECTION_CONFLICT");
      return { proposal, created: false };
    }
    const current = await this.getDossier(projection.profileId, projection.instrumentId);
    if (!baseMatchesDossier(projection, current?.dossier)) throw new Error("DOSSIER_REVISION_CONFLICT");
    const proposal: ResearchDossierProposal = {
      schemaVersion: DOSSIER_PROPOSAL_SCHEMA_VERSION,
      id: await resourceId("dossier-proposal", projection.profileId, projection.instrumentId, `${projection.sourceRunId}:${projection.base.dossierVersion}:${projection.base.dossierFingerprint ?? "none"}`), kind: "projection",
      profileId: projection.profileId, instrumentId: projection.instrumentId, dossierId: projection.base.dossierId,
      base: structuredClone(projection.base), sourceRunId: projection.sourceRunId, payload: structuredClone(projection), payloadFingerprint: projection.fingerprint,
      status: "pending", createdAt: projection.projectedAt, updatedAt: projection.projectedAt, expiresAt,
    };
    if (!isResearchDossierProposal(proposal)) throw new Error("DOSSIER_PROPOSAL_INTEGRITY_FAILURE");
    const response = await this.db.prepare("INSERT INTO research_dossier_proposals (id, kind, profile_id, instrument_id, dossier_id, base_key, source_run_id, payload_fingerprint, status, payload_json, created_at, updated_at, expires_at) VALUES (?, 'projection', ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?) ON CONFLICT(source_run_id, profile_id, base_key) DO NOTHING")
      .bind(proposal.id, proposal.profileId, proposal.instrumentId, proposal.dossierId, baseKey, proposal.sourceRunId, proposal.payloadFingerprint, JSON.stringify(proposal), proposal.createdAt, proposal.updatedAt, proposal.expiresAt).run();
    if (!response.meta.changes) return this.saveProjection(projection, expiresAt);
    return { proposal, created: true };
  }

  async saveRebasedProjection(projection: ResearchDossierProjection, expiresAt: string, idempotencyKey: string): Promise<{ proposal: ResearchDossierProposal; created: boolean }> {
    if (!validIdempotencyKey(idempotencyKey) || !isResearchDossierProjection(projection) || !await verifyResearchDossierProjectionFingerprint(projection)) throw new Error("DOSSIER_REBASE_INVALID");
    assertExpiry(projection.projectedAt, expiresAt);
    const hash = await rebaseRequestHash(projection);
    const prior = await this.readCommand(projection.profileId, idempotencyKey, hash);
    if (prior) return { proposal: parseProposalJson(prior), created: false };
    const baseKey = `${projection.base.dossierVersion}:${projection.base.dossierFingerprint ?? "none"}`;
    const existing = await this.db.prepare("SELECT payload_json FROM research_dossier_proposals WHERE source_run_id = ? AND profile_id = ? AND base_key = ?").bind(projection.sourceRunId, projection.profileId, baseKey).first<{ payload_json: string }>();
    if (existing) {
      const proposal = await verifyProposal(parseProposalJson(existing.payload_json));
      if (proposal.kind !== "projection" || !proposal.payload || await rebaseRequestHash(proposal.payload) !== hash) throw new Error("DOSSIER_PROJECTION_CONFLICT");
      await this.persistRecoveredRebaseCommand(projection, idempotencyKey, hash, proposal);
      return { proposal, created: false };
    }
    const current = await this.getDossier(projection.profileId, projection.instrumentId);
    if (!baseMatchesDossier(projection, current?.dossier)) throw new Error("DOSSIER_REVISION_CONFLICT");
    const proposal: ResearchDossierProposal = {
      schemaVersion: DOSSIER_PROPOSAL_SCHEMA_VERSION,
      id: await resourceId("dossier-proposal", projection.profileId, projection.instrumentId, `${projection.sourceRunId}:${baseKey}`),
      kind: "projection", profileId: projection.profileId, instrumentId: projection.instrumentId, dossierId: projection.base.dossierId,
      base: structuredClone(projection.base), sourceRunId: projection.sourceRunId, payload: structuredClone(projection), payloadFingerprint: projection.fingerprint,
      status: "pending", createdAt: projection.projectedAt, updatedAt: projection.projectedAt, expiresAt,
    };
    if (!isResearchDossierProposal(proposal)) throw new Error("DOSSIER_PROPOSAL_INTEGRITY_FAILURE");
    try {
      const responses = await this.db.batch([
        this.db.prepare("INSERT INTO research_dossier_proposals (id, kind, profile_id, instrument_id, dossier_id, base_key, source_run_id, payload_fingerprint, status, payload_json, created_at, updated_at, expires_at) VALUES (?, 'projection', ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)").bind(proposal.id, proposal.profileId, proposal.instrumentId, proposal.dossierId, baseKey, proposal.sourceRunId, proposal.payloadFingerprint, JSON.stringify(proposal), proposal.createdAt, proposal.updatedAt, proposal.expiresAt),
        this.db.prepare("INSERT INTO research_dossier_commands (profile_id, instrument_id, resource_id, idempotency_key, kind, command_hash, result_json, created_at) VALUES (?, ?, ?, ?, 'rebase', ?, ?, ?)").bind(projection.profileId, projection.instrumentId, proposal.id, idempotencyKey, hash, JSON.stringify(proposal), projection.projectedAt),
      ]);
      if (!responses[0]?.meta.changes || !responses[1]?.meta.changes) throw new Error("DOSSIER_REBASE_PERSISTENCE_FAILED");
      return { proposal, created: true };
    } catch (cause) {
      const recovered = await this.readCommand(projection.profileId, idempotencyKey, hash);
      if (recovered) return { proposal: parseProposalJson(recovered), created: false };
      throw cause;
    }
  }

  async getDossier(profileId: string, instrumentId: string): Promise<DossierWithRevision | null> {
    const row = await this.db.prepare("SELECT payload_json FROM research_dossiers WHERE profile_id = ? AND instrument_id = ?").bind(profileId, instrumentId).first<{ payload_json: string }>();
    if (!row) return null;
    const dossier = parseDossierJson(row.payload_json);
    const revision = await verifyCompleteRevisionChain(dossier, (revisionId) => this.getRevision(profileId, revisionId));
    return { dossier, revision };
  }

  async getRevision(profileId: string, revisionId: string): Promise<ResearchDossierRevision | null> {
    const row = await this.db.prepare("SELECT payload_json FROM research_dossier_revisions WHERE id = ? AND profile_id = ?").bind(revisionId, profileId).first<{ payload_json: string }>();
    if (!row) return null;
    const revision = parseRevisionJson(row.payload_json);
    if (!await verifyResearchDossierRevisionFingerprint(revision)) throw new Error("DOSSIER_INTEGRITY_FAILURE");
    return revision;
  }

  async confirm(proposalId: string, profileId: string, intent: DossierConfirmIntent, confirmedAt: string): Promise<DossierConfirmResult> {
    if (validateDossierConfirmIntent(intent).length > 0 || !isCanonicalIso(confirmedAt)) throw new Error("DOSSIER_CONFIRM_INVALID");
    const commandHash = await calculateCommandHash({ proposalId, profileId, intent });
    const prior = await this.readCommand(profileId, intent.idempotencyKey, commandHash);
    if (prior) return { ...parseConfirmResult(prior), reused: true };
    const proposal = await this.getProposal(proposalId, profileId);
    if (!proposal) throw new Error("DOSSIER_PROPOSAL_NOT_FOUND");
    if (!proposal.payload) throw new Error("DOSSIER_INTEGRITY_FAILURE");
    if (proposal.status === "expired" || Date.parse(confirmedAt) >= Date.parse(proposal.expiresAt)) throw new Error("DOSSIER_PROPOSAL_EXPIRED");
    if (proposal.status !== "pending") throw new Error("DOSSIER_PROPOSAL_NOT_PENDING");
    if (intent.expectedDossierVersion !== proposal.base.dossierVersion) throw new Error("DOSSIER_REVISION_CONFLICT");
    const current = await this.getDossier(profileId, proposal.instrumentId);
    if (!baseMatchesProposal(proposal, current?.dossier)) throw new Error("DOSSIER_REVISION_CONFLICT");
    const revision = await applyProposal(proposal, current?.revision ?? null, intent, confirmedAt);
    const dossier: ResearchDossier = current ? { ...current.dossier, currentRevisionId: revision.id, currentRevisionFingerprint: revision.fingerprint, version: current.dossier.version + 1, updatedAt: confirmedAt }
      : { schemaVersion: RESEARCH_DOSSIER_SCHEMA_VERSION, id: revision.dossierId, profileId, instrumentId: proposal.instrumentId, currentRevisionId: revision.id, version: 1, currentRevisionFingerprint: revision.fingerprint, createdAt: confirmedAt, updatedAt: confirmedAt };
    const confirmedProposal: ResearchDossierProposal = { ...proposal, status: "confirmed", updatedAt: confirmedAt };
    const result: DossierConfirmResult = { dossier, revision, proposal: confirmedProposal, reused: false };
    const dossierStatement = current
      ? this.db.prepare("UPDATE research_dossiers SET current_revision_id = ?, version = ?, current_revision_fingerprint = ?, payload_json = ?, updated_at = ? WHERE id = ? AND profile_id = ? AND version = ? AND current_revision_id = ?").bind(revision.id, dossier.version, revision.fingerprint, JSON.stringify(dossier), confirmedAt, dossier.id, profileId, current.dossier.version, current.dossier.currentRevisionId)
      : this.db.prepare("INSERT INTO research_dossiers (id, profile_id, instrument_id, current_revision_id, version, current_revision_fingerprint, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)").bind(dossier.id, profileId, dossier.instrumentId, revision.id, revision.fingerprint, JSON.stringify(dossier), confirmedAt, confirmedAt);
    const responses = await this.db.batch([
      this.db.prepare("INSERT INTO research_dossier_revisions (id, dossier_id, profile_id, instrument_id, revision_number, previous_revision_id, previous_fingerprint, source_proposal_id, fingerprint, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(revision.id, revision.dossierId, profileId, revision.instrumentId, revision.revisionNumber, revision.previousRevisionId, revision.previousFingerprint, proposal.id, revision.fingerprint, JSON.stringify(revision), confirmedAt),
      dossierStatement,
      this.db.prepare("UPDATE research_dossier_proposals SET status = 'confirmed', payload_json = ?, updated_at = ?, confirm_idempotency_key = ?, confirm_command_hash = ? WHERE id = ? AND profile_id = ? AND status = 'pending'").bind(JSON.stringify(confirmedProposal), confirmedAt, intent.idempotencyKey, commandHash, proposal.id, profileId),
      this.db.prepare("INSERT INTO research_dossier_commands (profile_id, instrument_id, resource_id, idempotency_key, kind, command_hash, result_json, created_at) VALUES (?, ?, ?, ?, 'confirm', ?, ?, ?)").bind(profileId, proposal.instrumentId, proposal.id, intent.idempotencyKey, commandHash, JSON.stringify(result), confirmedAt),
      this.db.prepare("INSERT INTO research_dossier_audit_events (id, dossier_id, profile_id, proposal_id, event_type, before_fingerprint, after_fingerprint, occurred_at) VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?)").bind(crypto.randomUUID(), dossier.id, profileId, proposal.id, current?.revision.fingerprint ?? null, revision.fingerprint, confirmedAt),
    ]);
    if (!responses[1]?.meta.changes || !responses[2]?.meta.changes) throw new Error("DOSSIER_REVISION_CONFLICT");
    return result;
  }

  async dismiss(proposalId: string, profileId: string, intent: DossierDismissIntent, dismissedAt: string): Promise<{ proposal: ResearchDossierProposal; reused: boolean }> {
    if (validateDossierDismissIntent(intent).length > 0 || !isCanonicalIso(dismissedAt)) throw new Error("DOSSIER_DISMISS_INVALID");
    const hash = await calculateCommandHash({ proposalId, profileId, intent });
    const prior = await this.readCommand(profileId, intent.idempotencyKey, hash);
    if (prior) return { proposal: parseProposalJson(prior), reused: true };
    const proposal = await this.getProposal(proposalId, profileId);
    if (!proposal) throw new Error("DOSSIER_PROPOSAL_NOT_FOUND");
    if (proposal.status !== "pending") throw new Error("DOSSIER_PROPOSAL_NOT_PENDING");
    const dismissed: ResearchDossierProposal = { ...proposal, status: "dismissed", updatedAt: dismissedAt };
    const responses = await this.db.batch([
      this.db.prepare("UPDATE research_dossier_proposals SET status = 'dismissed', payload_json = ?, updated_at = ? WHERE id = ? AND profile_id = ? AND status = 'pending'").bind(JSON.stringify(dismissed), dismissedAt, proposalId, profileId),
      this.db.prepare("INSERT INTO research_dossier_commands (profile_id, instrument_id, resource_id, idempotency_key, kind, command_hash, result_json, created_at) VALUES (?, ?, ?, ?, 'dismiss', ?, ?, ?)").bind(profileId, proposal.instrumentId, proposal.id, intent.idempotencyKey, hash, JSON.stringify(dismissed), dismissedAt),
      this.db.prepare("INSERT INTO research_dossier_audit_events (id, dossier_id, profile_id, proposal_id, event_type, before_fingerprint, after_fingerprint, occurred_at) VALUES (?, ?, ?, ?, 'dismissed', ?, NULL, ?)").bind(crypto.randomUUID(), proposal.dossierId, profileId, proposal.id, proposal.base.dossierFingerprint, dismissedAt),
    ]);
    if (!responses[0]?.meta.changes) throw new Error("DOSSIER_PROPOSAL_NOT_PENDING");
    return { proposal: dismissed, reused: false };
  }

  async createManualThesisProposal(profileId: string, instrumentId: string, intent: ManualThesisProposalIntent, createdAt: string, expiresAt: string): Promise<{ proposal: ResearchDossierProposal; created: boolean }> {
    if (validateManualThesisProposalIntent(intent).length > 0 || !isCanonicalIso(createdAt)) throw new Error("DOSSIER_THESIS_INTENT_INVALID");
    assertExpiry(createdAt, expiresAt);
    const hash = await calculateCommandHash({ profileId, instrumentId, intent });
    const prior = await this.readCommand(profileId, intent.idempotencyKey, hash);
    if (prior) return { proposal: parseProposalJson(prior), created: false };
    const state = await this.getDossier(profileId, instrumentId);
    if (!state || state.dossier.version !== intent.expectedDossierVersion) throw new Error("DOSSIER_REVISION_CONFLICT");
    const { expectedDossierVersion: _version, idempotencyKey: _key, ...operation } = intent;
    const proposal: ResearchDossierProposal = {
      schemaVersion: DOSSIER_PROPOSAL_SCHEMA_VERSION, id: await resourceId("dossier-proposal", profileId, instrumentId, `manual:${intent.idempotencyKey}`), kind: "manual_thesis", profileId, instrumentId, dossierId: state.dossier.id,
      base: { schemaVersion: "dossier-base-receipt.v1", profileId, instrumentId, dossierId: state.dossier.id, revisionId: state.revision.id, dossierVersion: state.dossier.version, dossierFingerprint: state.revision.fingerprint },
      sourceRunId: null, payload: operation, payloadFingerprint: await calculateCommandHash(operation), status: "pending", createdAt, updatedAt: createdAt, expiresAt,
    };
    if (!isResearchDossierProposal(proposal)) throw new Error("DOSSIER_PROPOSAL_INTEGRITY_FAILURE");
    await this.db.batch([
      this.db.prepare("INSERT INTO research_dossier_proposals (id, kind, profile_id, instrument_id, dossier_id, base_key, source_run_id, payload_fingerprint, status, payload_json, created_at, updated_at, expires_at) VALUES (?, 'manual_thesis', ?, ?, ?, ?, NULL, ?, 'pending', ?, ?, ?, ?)").bind(proposal.id, profileId, instrumentId, proposal.dossierId, `${proposal.base.dossierVersion}:${proposal.base.dossierFingerprint}`, proposal.payloadFingerprint, JSON.stringify(proposal), createdAt, createdAt, expiresAt),
      this.db.prepare("INSERT INTO research_dossier_commands (profile_id, instrument_id, resource_id, idempotency_key, kind, command_hash, result_json, created_at) VALUES (?, ?, ?, ?, 'manual_thesis', ?, ?, ?)").bind(profileId, instrumentId, proposal.id, intent.idempotencyKey, hash, JSON.stringify(proposal), createdAt),
    ]);
    return { proposal, created: true };
  }

  async createAlertRuleDraft(proposalId: string, profileId: string, intent: AlertRuleDraftIntent, createdAt: string): Promise<{ draft: AlertRuleDraft; reused: boolean }> {
    if (validateAlertRuleDraftIntent(intent).length > 0 || !isCanonicalIso(createdAt)) throw new Error("ALERT_DRAFT_INTENT_INVALID");
    const hash = await calculateCommandHash({ proposalId, profileId, intent });
    const prior = await this.readCommand(profileId, intent.idempotencyKey, hash);
    if (prior) return { draft: parseAlertDraftJson(prior), reused: true };
    const proposal = await this.getProposal(proposalId, profileId);
    if (!proposal || proposal.kind !== "projection") throw new Error("DOSSIER_PROPOSAL_NOT_FOUND");
    assertProposalAllowsAlert(proposal, createdAt);
    if (!proposal.payload) throw new Error("DOSSIER_INTEGRITY_FAILURE");
    const delta = proposal.payload.factDeltas.find((item) => item.id === intent.deltaId);
    if (!delta) throw new Error("ALERT_DRAFT_DELTA_NOT_FOUND");
    if (intent.template === "new_reporting_period" && delta.kind !== "period_advanced") throw new Error("ALERT_DRAFT_TEMPLATE_MISMATCH");
    if (!delta.current.quality.reliable) throw new Error("ALERT_DRAFT_RELIABLE_FACT_REQUIRED");
    const predicate = intent.template === "new_reporting_period"
      ? { version: "financial-alert-predicate.v1" as const, template: "new_reporting_period" as const, metric: delta.current.metric, baselinePeriod: structuredClone(delta.current.period) }
      : { version: "financial-alert-predicate.v1" as const, template: "metric_threshold_crossing" as const, metric: delta.current.metric, baselinePeriod: structuredClone(delta.current.period), field: intent.field, operator: intent.operator, threshold: { decimal: intent.threshold, unit: comparisonUnit(delta.current, intent.field) } };
    const expiresAt = new Date(Date.parse(createdAt) + 30 * 24 * 60 * 60 * 1_000).toISOString();
    const unsigned: Omit<AlertRuleDraft, "fingerprint"> = { schemaVersion: ALERT_RULE_DRAFT_SCHEMA_VERSION, id: await resourceId("alert-draft", profileId, proposal.instrumentId, intent.idempotencyKey), profileId, instrumentId: proposal.instrumentId, sourceProposalId: proposal.id, sourceProjectionFingerprint: proposal.payload.fingerprint, sourceDeltaId: delta.id, sourceEvidenceIds: [delta.current.evidenceId], researchFingerprint: proposal.payload.researchFingerprint, predicate, requiresReliableFacts: true, status: "draft", createdAt, expiresAt };
    const draft: AlertRuleDraft = { ...unsigned, fingerprint: await calculateAlertRuleDraftFingerprint(unsigned) };
    await this.db.batch([
      this.db.prepare("INSERT INTO alert_rule_drafts (id, profile_id, instrument_id, source_proposal_id, source_delta_id, fingerprint, payload_json, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)").bind(draft.id, profileId, draft.instrumentId, proposal.id, delta.id, draft.fingerprint, JSON.stringify(draft), createdAt, expiresAt),
      this.db.prepare("INSERT INTO research_dossier_commands (profile_id, instrument_id, resource_id, idempotency_key, kind, command_hash, result_json, created_at) VALUES (?, ?, ?, ?, 'alert_draft', ?, ?, ?)").bind(profileId, proposal.instrumentId, draft.id, intent.idempotencyKey, hash, JSON.stringify(draft), createdAt),
    ]);
    return { draft, reused: false };
  }

  async listAlertRuleDrafts(profileId: string): Promise<AlertRuleDraft[]> {
    const result = await this.db.prepare("SELECT payload_json FROM alert_rule_drafts WHERE profile_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 100").bind(profileId).all<{ payload_json: string }>();
    const drafts: AlertRuleDraft[] = [];
    for (const row of result.results) {
      const draft = parseAlertDraftJson(row.payload_json);
      if (!await verifyAlertRuleDraftFingerprint(draft)) throw new Error("DOSSIER_INTEGRITY_FAILURE");
      drafts.push(draft);
    }
    return drafts;
  }

  async sweepRetention(now: string): Promise<{ expiredProposals: number; purgedProposalPayloads: number; expiredAlertDrafts: number }> {
    if (!isCanonicalIso(now)) throw new Error("DOSSIER_RETENTION_TIME_INVALID");
    const purgeBefore = new Date(Date.parse(now) - 90 * 24 * 60 * 60 * 1_000).toISOString();
    const expiring = await this.db.prepare("SELECT payload_json FROM research_dossier_proposals WHERE status = 'pending' AND expires_at <= ? LIMIT 500").bind(now).all<{ payload_json: string }>();
    const statements: D1PreparedStatement[] = [];
    for (const row of expiring.results) {
      const proposal = await verifyProposal(parseProposalJson(row.payload_json));
      const expired: ResearchDossierProposal = { ...proposal, status: "expired", updatedAt: now };
      statements.push(this.db.prepare("UPDATE research_dossier_proposals SET status = 'expired', payload_json = ?, updated_at = ? WHERE id = ? AND profile_id = ? AND status = 'pending'").bind(JSON.stringify(expired), now, proposal.id, proposal.profileId));
    }
    const expiredResponses = statements.length > 0 ? await this.db.batch(statements) : [];
    await this.db.prepare("UPDATE research_dossier_commands SET result_json = NULL WHERE result_json IS NOT NULL AND (resource_id IN (SELECT id FROM research_dossier_proposals WHERE status IN ('dismissed', 'expired', 'stale') AND updated_at <= ?) OR resource_id IN (SELECT id FROM alert_rule_drafts WHERE expires_at <= ?))").bind(purgeBefore, now).run();
    const purged = await this.db.prepare("UPDATE research_dossier_proposals SET payload_json = json_set(payload_json, '$.payload', json('null')) WHERE status IN ('dismissed', 'expired', 'stale') AND updated_at <= ? AND json_extract(payload_json, '$.payload') IS NOT NULL").bind(purgeBefore).run();
    const drafts = await this.db.prepare("DELETE FROM alert_rule_drafts WHERE expires_at <= ?").bind(now).run();
    return { expiredProposals: expiredResponses.reduce((sum, response) => sum + Number(response.meta.changes ?? 0), 0), purgedProposalPayloads: Number(purged.meta.changes ?? 0), expiredAlertDrafts: Number(drafts.meta.changes ?? 0) };
  }

  async purgeDossier(profileId: string, instrumentId: string, intent: DossierPurgeIntent, purgedAt: string): Promise<{ purged: true; reused: boolean }> {
    assertPurgeIntent(intent, purgedAt);
    const hash = await calculateCommandHash({ profileId, instrumentId, confirmation: intent.confirmation });
    const prior = await this.readCommand(profileId, intent.idempotencyKey, hash);
    if (prior) return { purged: true, reused: true };
    const state = await this.getDossier(profileId, instrumentId);
    if (!state) throw new Error("DOSSIER_NOT_FOUND");
    const safeResult = JSON.stringify({ purged: true });
    await this.db.batch([
      this.db.prepare("DELETE FROM alert_rule_drafts WHERE profile_id = ? AND instrument_id = ?").bind(profileId, instrumentId),
      this.db.prepare("DELETE FROM research_dossier_commands WHERE profile_id = ? AND instrument_id = ?").bind(profileId, instrumentId),
      this.db.prepare("DELETE FROM research_dossier_proposals WHERE profile_id = ? AND instrument_id = ?").bind(profileId, instrumentId),
      this.db.prepare("DELETE FROM research_dossier_revisions WHERE dossier_id = ? AND profile_id = ?").bind(state.dossier.id, profileId),
      this.db.prepare("DELETE FROM research_dossiers WHERE id = ? AND profile_id = ? AND instrument_id = ?").bind(state.dossier.id, profileId, instrumentId),
      this.db.prepare("DELETE FROM research_dossier_audit_events WHERE dossier_id = ? AND profile_id = ?").bind(state.dossier.id, profileId),
      this.db.prepare("INSERT INTO research_dossier_audit_events (id, dossier_id, profile_id, proposal_id, event_type, before_fingerprint, after_fingerprint, occurred_at) VALUES (?, ?, ?, NULL, 'purged', ?, NULL, ?)").bind(crypto.randomUUID(), state.dossier.id, profileId, state.revision.fingerprint, purgedAt),
      this.db.prepare("INSERT INTO research_dossier_commands (profile_id, instrument_id, resource_id, idempotency_key, kind, command_hash, result_json, created_at) VALUES (?, ?, ?, ?, 'purge', ?, ?, ?)").bind(profileId, instrumentId, state.dossier.id, intent.idempotencyKey, hash, safeResult, purgedAt),
    ]);
    return { purged: true, reused: false };
  }

  async getProposal(id: string, profileId: string): Promise<ResearchDossierProposal | null> {
    const row = await this.db.prepare("SELECT payload_json FROM research_dossier_proposals WHERE id = ? AND profile_id = ?").bind(id, profileId).first<{ payload_json: string }>();
    return row ? verifyProposal(parseProposalJson(row.payload_json)) : null;
  }

  private async persistRecoveredRebaseCommand(projection: ResearchDossierProjection, idempotencyKey: string, hash: string, proposal: ResearchDossierProposal): Promise<void> {
    try {
      await this.db.prepare("INSERT INTO research_dossier_commands (profile_id, instrument_id, resource_id, idempotency_key, kind, command_hash, result_json, created_at) VALUES (?, ?, ?, ?, 'rebase', ?, ?, ?)")
        .bind(projection.profileId, projection.instrumentId, proposal.id, idempotencyKey, hash, JSON.stringify(proposal), projection.projectedAt).run();
    } catch (cause) {
      const recovered = await this.readCommand(projection.profileId, idempotencyKey, hash);
      if (!recovered) throw cause;
    }
  }

  private async readCommand(profileId: string, idempotencyKey: string, expectedHash: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT command_hash, result_json FROM research_dossier_commands WHERE profile_id = ? AND idempotency_key = ?").bind(profileId, idempotencyKey).first<{ command_hash: string; result_json: string | null }>();
    if (!row) return null;
    if (row.command_hash !== expectedHash) throw new Error("DOSSIER_IDEMPOTENCY_CONFLICT");
    return row.result_json ?? null;
  }
}

async function applyProposal(proposal: ResearchDossierProposal, previous: ResearchDossierRevision | null, intent: DossierConfirmIntent, confirmedAt: string): Promise<ResearchDossierRevision> {
  if (!proposal.payload) throw new Error("DOSSIER_PROPOSAL_KIND_UNSUPPORTED");
  const accepted = new Set(intent.acceptedThesisImpactIds);
  const impactIds = new Set(proposal.kind === "projection" ? proposal.payload.thesisImpacts.map((impact) => impact.id) : []);
  if ([...accepted].some((id) => !impactIds.has(id))) throw new Error("DOSSIER_CONFIRM_INVALID");
  const anchors = new Map((previous?.factAnchors ?? []).map((anchor) => [anchor.logicalSeriesKey, structuredClone(anchor)]));
  const observations = new Map<string, DossierFactAnchor>();
  for (const anchor of previous?.unverifiedObservations ?? []) {
    const prior = observations.get(anchor.logicalSeriesKey);
    if (!prior || anchorRecency(anchor) > anchorRecency(prior)) observations.set(anchor.logicalSeriesKey, structuredClone(anchor));
  }
  if (proposal.kind === "projection") {
    for (const delta of proposal.payload.factDeltas) {
      if (delta.current.quality.reliable) {
        anchors.set(delta.logicalSeriesKey, structuredClone(delta.current));
        if (observations.get(delta.logicalSeriesKey)?.factId === delta.current.factId) observations.delete(delta.logicalSeriesKey);
      } else {
        const prior = observations.get(delta.logicalSeriesKey);
        if (!prior || anchorRecency(delta.current) >= anchorRecency(prior)) observations.set(delta.logicalSeriesKey, structuredClone(delta.current));
      }
    }
  }
  const theses = [...(previous?.theses ?? [])].map((thesis) => structuredClone(thesis));
  if (proposal.kind === "projection") {
    for (const impact of proposal.payload.thesisImpacts.filter((item) => accepted.has(item.id))) {
      const index = theses.findIndex((thesis) => thesis.id === impact.thesisId);
      if (index < 0) throw new Error("DOSSIER_CONFIRM_INVALID");
      const assessment: ThesisAssessment = { ...structuredClone(impact), sourceProposalId: proposal.id, assessedAt: confirmedAt };
      const thesis = theses[index]!;
      theses[index] = { ...thesis, status: impact.impact === "invalidates" ? "invalidated" : thesis.status, assessments: [...thesis.assessments, assessment], updatedAt: confirmedAt };
    }
  } else {
    const operation = proposal.payload;
    if (operation.operation === "create") {
      theses.push({ id: await resourceId("thesis", proposal.profileId, proposal.instrumentId, proposal.id), text: operation.text.trim(), status: "active", revision: 1, assessments: [], createdAt: confirmedAt, updatedAt: confirmedAt });
    } else {
      const index = theses.findIndex((thesis) => thesis.id === operation.thesisId);
      if (index < 0) throw new Error("DOSSIER_THESIS_NOT_FOUND");
      const thesis = theses[index]!;
      if (operation.operation === "revise") theses[index] = { ...thesis, text: operation.text.trim(), revision: thesis.revision + 1, updatedAt: confirmedAt };
      else theses[index] = { ...thesis, status: operation.operation === "invalidate" ? "invalidated" : "retired", revision: thesis.revision + 1, updatedAt: confirmedAt };
    }
  }
  const dossierId = previous?.dossierId ?? await resourceId("dossier", proposal.profileId, proposal.instrumentId, "root");
  const revisionNumber = (previous?.revisionNumber ?? 0) + 1;
  const unsigned: Omit<ResearchDossierRevision, "fingerprint"> = {
    schemaVersion: RESEARCH_DOSSIER_REVISION_SCHEMA_VERSION,
    id: await resourceId("dossier-revision", proposal.profileId, proposal.instrumentId, `${dossierId}:${revisionNumber}`),
    dossierId,
    profileId: proposal.profileId,
    instrumentId: proposal.instrumentId,
    revisionNumber,
    previousRevisionId: previous?.id ?? null,
    previousFingerprint: previous?.fingerprint ?? null,
    sourceProposalId: proposal.id,
    observationCutoff: proposal.kind === "projection" ? proposal.payload.observationCutoff : previous!.observationCutoff,
    knowledgeCutoff: proposal.kind === "projection" ? proposal.payload.knowledgeCutoff : previous!.knowledgeCutoff,
    factAnchors: [...anchors.values()].sort((left, right) => left.logicalSeriesKey.localeCompare(right.logicalSeriesKey)),
    unverifiedObservations: [...observations.values()].sort((left, right) => left.logicalSeriesKey.localeCompare(right.logicalSeriesKey) || left.period.end.localeCompare(right.period.end)),
    theses,
    createdAt: confirmedAt,
  };
  const revision: ResearchDossierRevision = { ...unsigned, fingerprint: await calculateResearchDossierRevisionFingerprint(unsigned) };
  if (!isResearchDossierRevision(revision) || !await verifyResearchDossierRevisionFingerprint(revision)) throw new Error("DOSSIER_INTEGRITY_FAILURE");
  return revision;
}

function baseMatchesDossier(projection: ResearchDossierProjection, dossier: ResearchDossier | undefined): boolean {
  if (!dossier) return projection.base.dossierVersion === 0 && projection.base.dossierId === null && projection.base.revisionId === null && projection.base.dossierFingerprint === null;
  return projection.base.dossierId === dossier.id && projection.base.revisionId === dossier.currentRevisionId && projection.base.dossierVersion === dossier.version && projection.base.dossierFingerprint === dossier.currentRevisionFingerprint;
}

function baseMatchesProposal(proposal: ResearchDossierProposal, dossier: ResearchDossier | undefined): boolean {
  if (!dossier) return proposal.base.dossierVersion === 0 && proposal.base.dossierId === null;
  return proposal.base.dossierId === dossier.id && proposal.base.revisionId === dossier.currentRevisionId && proposal.base.dossierVersion === dossier.version && proposal.base.dossierFingerprint === dossier.currentRevisionFingerprint;
}

function assertExpiry(createdAt: string, expiresAt: string): void {
  const duration = Date.parse(expiresAt) - Date.parse(createdAt);
  if (!isCanonicalIso(expiresAt) || duration <= 0 || duration > 30 * 24 * 60 * 60 * 1_000) throw new Error("DOSSIER_PROPOSAL_EXPIRY_INVALID");
}

function assertProposalAllowsAlert(proposal: ResearchDossierProposal, createdAt: string): void {
  if (proposal.status === "expired" || Date.parse(createdAt) >= Date.parse(proposal.expiresAt)) throw new Error("DOSSIER_PROPOSAL_EXPIRED");
  if (proposal.status !== "pending") throw new Error("DOSSIER_PROPOSAL_NOT_PENDING");
}

async function verifyCompleteRevisionChain(
  dossier: ResearchDossier,
  getRevision: (revisionId: string) => Promise<ResearchDossierRevision | null>,
): Promise<ResearchDossierRevision> {
  if (!isResearchDossier(dossier)) throw new Error("DOSSIER_INTEGRITY_FAILURE");
  if (dossier.version > MAX_DOSSIER_REVISION_CHAIN_LENGTH) throw new Error("DOSSIER_INTEGRITY_FAILURE");
  let expectedId = dossier.currentRevisionId;
  let expectedFingerprint = dossier.currentRevisionFingerprint;
  let expectedNumber = dossier.version;
  let current: ResearchDossierRevision | null = null;
  const visited = new Set<string>();
  while (expectedNumber >= 1) {
    if (visited.has(expectedId)) throw new Error("DOSSIER_INTEGRITY_FAILURE");
    visited.add(expectedId);
    const revision = await getRevision(expectedId);
    if (
      !revision
      || revision.id !== expectedId
      || revision.fingerprint !== expectedFingerprint
      || revision.dossierId !== dossier.id
      || revision.profileId !== dossier.profileId
      || revision.instrumentId !== dossier.instrumentId
      || revision.revisionNumber !== expectedNumber
      || !await verifyResearchDossierRevisionFingerprint(revision)
    ) throw new Error("DOSSIER_INTEGRITY_FAILURE");
    current ??= revision;
    if (expectedNumber === 1) {
      if (revision.previousRevisionId !== null || revision.previousFingerprint !== null) throw new Error("DOSSIER_INTEGRITY_FAILURE");
    } else {
      if (!revision.previousRevisionId || !revision.previousFingerprint) throw new Error("DOSSIER_INTEGRITY_FAILURE");
      expectedId = revision.previousRevisionId;
      expectedFingerprint = revision.previousFingerprint;
    }
    expectedNumber -= 1;
  }
  if (!current) throw new Error("DOSSIER_INTEGRITY_FAILURE");
  return current;
}

function runKey(runId: string, profileId: string): string { return `${profileId}:${runId}`; }
function dossierKey(profileId: string, instrumentId: string): string { return `${profileId}:${instrumentId}`; }
function comparisonUnit(anchor: { value: { unit: "CNY" | "ratio" | "shares" }; comparisons: Array<{ kind: "yoy" | "qoq" }> }, field: "value" | "yoy" | "qoq"): "CNY" | "ratio" | "shares" {
  if (field === "value") return anchor.value.unit;
  if (!anchor.comparisons.some((comparison) => comparison.kind === field)) throw new Error("ALERT_DRAFT_COMPARISON_UNAVAILABLE");
  return "ratio";
}
function anchorRecency(anchor: DossierFactAnchor): string { return `${anchor.period.end}|${anchor.provenance.sourceAsOf}|${anchor.provenance.retrievedAt}|${anchor.factId}`; }
function parseProposalJson(value: string): ResearchDossierProposal { let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error("DOSSIER_INTEGRITY_FAILURE"); } if (!isResearchDossierProposal(parsed)) throw new Error("DOSSIER_INTEGRITY_FAILURE"); return parsed; }
function parseDossierJson(value: string): ResearchDossier { let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error("DOSSIER_INTEGRITY_FAILURE"); } if (!isResearchDossier(parsed)) throw new Error("DOSSIER_INTEGRITY_FAILURE"); return parsed; }
function parseRevisionJson(value: string): ResearchDossierRevision { let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error("DOSSIER_INTEGRITY_FAILURE"); } if (!isResearchDossierRevision(parsed)) throw new Error("DOSSIER_INTEGRITY_FAILURE"); return parsed; }
function parseAlertDraftJson(value: string): AlertRuleDraft { let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error("DOSSIER_INTEGRITY_FAILURE"); } if (!isAlertRuleDraft(parsed)) throw new Error("DOSSIER_INTEGRITY_FAILURE"); return parsed; }
function parseConfirmResult(value: string): DossierConfirmResult {
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { throw new Error("DOSSIER_INTEGRITY_FAILURE"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("DOSSIER_INTEGRITY_FAILURE");
  const result = parsed as Partial<DossierConfirmResult>;
  if (!isResearchDossier(result.dossier) || !isResearchDossierRevision(result.revision) || !isResearchDossierProposal(result.proposal)) throw new Error("DOSSIER_INTEGRITY_FAILURE");
  return { dossier: result.dossier, revision: result.revision, proposal: result.proposal, reused: false };
}
async function verifyProposal(proposal: ResearchDossierProposal): Promise<ResearchDossierProposal> {
  if (proposal.kind === "projection" && proposal.payload && !await verifyResearchDossierProjectionFingerprint(proposal.payload)) throw new Error("DOSSIER_INTEGRITY_FAILURE");
  if (proposal.kind === "manual_thesis" && proposal.payload && await calculateCommandHash(proposal.payload) !== proposal.payloadFingerprint) throw new Error("DOSSIER_INTEGRITY_FAILURE");
  return proposal;
}
async function calculateCommandHash(value: unknown): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value))));
  return `sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
function rebaseRequestHash(projection: ResearchDossierProjection): Promise<`sha256:${string}`> {
  return calculateCommandHash({
    profileId: projection.profileId,
    instrumentId: projection.instrumentId,
    sourceRunId: projection.sourceRunId,
    sourceEvidenceFingerprint: projection.sourceEvidenceFingerprint,
    researchFingerprint: projection.researchFingerprint,
    observationCutoff: projection.observationCutoff,
    knowledgeCutoff: projection.knowledgeCutoff,
    base: projection.base,
  });
}
async function resourceId(kind: "dossier-proposal" | "alert-draft" | "dossier" | "dossier-revision" | "thesis", profileId: string, instrumentId: string, key: string): Promise<string> {
  const hash = await calculateCommandHash({ kind, profileId, instrumentId, key });
  return `${kind}:${hash.slice("sha256:".length)}`;
}
function assertPurgeIntent(intent: DossierPurgeIntent, purgedAt: string): void {
  if (!intent || intent.confirmation !== "DELETE_RESEARCH_DOSSIER" || !validIdempotencyKey(intent.idempotencyKey) || Object.keys(intent).sort().join(",") !== "confirmation,idempotencyKey" || !isCanonicalIso(purgedAt)) throw new Error("DOSSIER_PURGE_INVALID");
}
function clearMemoryCommandBodiesForProposal(
  dismissCommands: Map<string, { hash: string; proposal?: ResearchDossierProposal }>,
  manualCommands: Map<string, { hash: string; proposal?: ResearchDossierProposal }>,
  rebaseCommands: Map<string, { hash: string; result?: { proposal: ResearchDossierProposal; created: boolean } }>,
  proposalId: string,
): void {
  for (const [key, command] of dismissCommands) if (command.proposal?.id === proposalId) dismissCommands.set(key, { hash: command.hash });
  for (const [key, command] of manualCommands) if (command.proposal?.id === proposalId) manualCommands.set(key, { hash: command.hash });
  for (const [key, command] of rebaseCommands) if (command.result?.proposal.id === proposalId) rebaseCommands.set(key, { hash: command.hash });
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function validIdempotencyKey(value: string): boolean { return /^[A-Za-z0-9._:-]{8,128}$/.test(value); }
function isCanonicalIso(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)); }
