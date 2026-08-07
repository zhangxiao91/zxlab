import type { MarketSnapshot } from "@zxlab/market-schema";

export const MARKET_AGENT_SCHEMA_VERSION = "market-agent.v1" as const;
export const EVENT_RULE_VERSION = "market-event.v1" as const;

export type AgentWorkflow = "morning_brief" | "close_review" | "inspect_instrument" | "portfolio_impact";
export type RunTrigger = "manual" | "scheduled" | "bot";
export type RunStatus = "queued" | "collecting" | "evidence_sealed" | "generating" | "validating" | "retry_wait" | "success" | "partial" | "failed";
export type EvidenceKind = "market_fact" | "market_event" | "portfolio_impact" | "confirmed_context" | "limitation";
export type ObservationClass = "fact" | "inference" | "unknown";
export type ObservationImportance = "high" | "medium" | "low";

export interface BrowserRunIntent { workflow: AgentWorkflow; instrumentId?: string; question?: string; marketDate?: string; idempotencyKey: string; }
export interface MarketAgentCommand extends BrowserRunIntent { profileId: string; trigger: RunTrigger; }
export interface MarketEvent { id: string; ruleId: string; instrumentId: string | null; kind: string; observedAt: string; actual: number | string | null; threshold: number | string | null; reliable: boolean; evidenceId: string; dedupeKey: string; }
export interface ConfirmedContextUse { memoryId: string; role: string; revisionHash: string; usedAt: string; }
export interface EvidenceItem { id: string; kind: EvidenceKind; origin: "server-observed" | "user-supplied-risk-snapshot" | "canonical-context"; value: unknown; reliable: boolean; }
export interface SealedEvidenceBundle { schemaVersion: typeof MARKET_AGENT_SCHEMA_VERSION; eventRuleVersion: typeof EVENT_RULE_VERSION; profileId: string; workflow: AgentWorkflow; watchlistRevision: string; instrumentIds: string[]; items: EvidenceItem[]; contextUses: ConfirmedContextUse[]; fingerprint: `sha256:${string}`; sealedAt: string; }
export interface AgentObservation { id: string; class: ObservationClass; importance: ObservationImportance; title: string; explanation: string; evidenceIds: string[]; }
export interface AgentNarration { status: "success" | "partial"; headline: string; summary: string; observations: AgentObservation[]; portfolioImpacts: AgentObservation[]; watchNext: Array<{ condition: string; reason: string; evidenceIds: string[] }>; limitations: string[]; evidenceFingerprint: string; }
export interface AgentResult extends AgentNarration { mode: "market-only" | "portfolio-aware"; }
export interface AgentRun { id: string; profileId: string; workflow: AgentWorkflow; trigger: RunTrigger; status: RunStatus; idempotencyKey: string; commandHash: string; revisionOfRunId: string | null; attempt: number; recoveryGeneration: number; createdAt: string; updatedAt: string; evidenceFingerprint: string | null; failure: { code: string; retryable: boolean } | null; result?: AgentResult; }

export interface RunCreation { command: MarketAgentCommand; actorScope: string; commandHash: `sha256:${string}`; revisionOfRunId?: string; }
export type RunClaimResult = { kind: "claimed"; lease: { run: AgentRun; leaseToken: string; attempt: number; leaseExpiresAt: string } } | { kind: "terminal" } | { kind: "leased"; retryAfter: string } | { kind: "missing" };

export type ActorKind = "human" | "agent";
export interface ActorRequestBinding { method: string; path: string; bodyHash: `sha256:${string}`; }
export interface ActorEnvelopePayload {
  version: 2;
  kind: ActorKind;
  subject: string;
  ownerSubject: string;
  actorId: string;
  scopes: string[];
  audience: "market-agent";
  issuedAt: number;
  expiresAt: number;
  jti: string;
  request: ActorRequestBinding;
}
export interface ActorEnvelopeVerificationOptions { now?: number; request?: ActorRequestBinding; }
export async function signActorEnvelope(payload: ActorEnvelopePayload, secret: string): Promise<string> {
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  return `${encoded}.${base64UrlEncode(await hmac(encoded, secret))}`;
}
export async function verifyActorEnvelope(envelope: string | null, secret: string, options: ActorEnvelopeVerificationOptions = {}): Promise<ActorEnvelopePayload> {
  if (!envelope || !secret) throw new Error("ACTOR_ENVELOPE_MISSING");
  if (!options.request) throw new Error("ACTOR_ENVELOPE_REQUEST_MISSING");
  const [encoded, supplied, extra] = envelope.split(".");
  if (!encoded || !supplied || extra) throw new Error("ACTOR_ENVELOPE_INVALID");
  const expected = await hmac(encoded, secret); const actual = base64UrlDecode(supplied);
  if (!timingSafeEqual(expected, actual)) throw new Error("ACTOR_ENVELOPE_INVALID");
  let payload: ActorEnvelopePayload;
  try { payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as ActorEnvelopePayload; } catch { throw new Error("ACTOR_ENVELOPE_INVALID"); }
  const now = Math.floor((options.now ?? Date.now()) / 1_000);
  if (!validActorEnvelope(payload, now) || !sameRequestBinding(payload.request, options.request)) throw new Error("ACTOR_ENVELOPE_INVALID");
  return payload;
}
export async function actorRequestBodyHash(request: Request): Promise<`sha256:${string}`> {
  const body = await request.clone().arrayBuffer();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", body));
  return `sha256:${hex(digest)}`;
}
export function createActorRequestBinding(method: string, path: string, bodyHash: `sha256:${string}`): ActorRequestBinding {
  return { method: method.toUpperCase(), path, bodyHash };
}
export async function subjectHash(subject: string, secret: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:${subject}`));
  return `sha256:${hex(new Uint8Array(bytes))}`;
}

export function validateBrowserRunIntent(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["intent must be an object"];
  if (!oneOf(value.workflow, ["morning_brief", "close_review", "inspect_instrument", "portfolio_impact"])) issues.push("workflow is invalid");
  if (typeof value.idempotencyKey !== "string" || value.idempotencyKey.length < 8 || value.idempotencyKey.length > 180) issues.push("idempotencyKey is invalid");
  if (value.instrumentId !== undefined && (typeof value.instrumentId !== "string" || value.instrumentId.length > 32)) issues.push("instrumentId is invalid");
  if (value.question !== undefined && (typeof value.question !== "string" || value.question.length > 4000)) issues.push("question is invalid");
  if (value.marketDate !== undefined && (typeof value.marketDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.marketDate))) issues.push("marketDate is invalid");
  if ("profileId" in value || "trigger" in value) issues.push("profileId and trigger are server-only");
  return issues;
}

export function validateSealedEvidence(value: unknown): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["evidence must be an object"];
  if (value.schemaVersion !== MARKET_AGENT_SCHEMA_VERSION) issues.push("schemaVersion is invalid");
  if (value.eventRuleVersion !== EVENT_RULE_VERSION) issues.push("eventRuleVersion is invalid");
  if (typeof value.fingerprint !== "string" || !value.fingerprint.startsWith("sha256:")) issues.push("fingerprint is invalid");
  if (!Array.isArray(value.items) || value.items.length > 500) issues.push("items are invalid");
  return issues;
}

export function validateAgentNarration(value: unknown, evidence: SealedEvidenceBundle): string[] {
  const issues: string[] = [];
  if (!isRecord(value)) return ["narration must be an object"];
  if (!oneOf(value.status, ["success", "partial"])) issues.push("status is invalid");
  if (typeof value.headline !== "string" || value.headline.length === 0 || value.headline.length > 240) issues.push("headline is invalid");
  if (typeof value.summary !== "string" || value.summary.length > 4000) issues.push("summary is invalid");
  if (value.evidenceFingerprint !== evidence.fingerprint) issues.push("evidenceFingerprint must match sealed evidence");
  const evidenceIds = new Set(evidence.items.map((item) => item.id));
  for (const field of ["observations", "portfolioImpacts"] as const) {
    if (!Array.isArray(value[field])) { issues.push(`${field} must be an array`); continue; }
    for (const [index, observation] of value[field].entries()) validateObservation(observation, `${field}[${index}]`, evidenceIds, issues);
  }
  if (!Array.isArray(value.watchNext)) issues.push("watchNext must be an array");
  if (!Array.isArray(value.limitations) || value.limitations.some((item) => typeof item !== "string")) issues.push("limitations must be string[]");
  const text = JSON.stringify(value).toLowerCase();
  if (/\b(buy|sell|short|long|trade|purchase|下单|买入|卖出|加仓|减仓|做多|做空)\b/.test(text)) issues.push("trading instructions are forbidden");
  return issues;
}

export function eventEvidenceId(runId: string, index: number): string { return `${runId}:event:${index}`; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function oneOf(value: unknown, values: readonly string[]): boolean { return typeof value === "string" && values.includes(value); }
function validActorEnvelope(value: ActorEnvelopePayload, now: number): boolean {
  if (!isRecord(value) || value.version !== 2 || value.audience !== "market-agent") return false;
  if (value.kind !== "human" && value.kind !== "agent") return false;
  if (!boundedString(value.subject) || !boundedString(value.ownerSubject) || !boundedString(value.actorId) || !boundedString(value.jti)) return false;
  if (!Array.isArray(value.scopes) || value.scopes.length === 0 || value.scopes.length > 32 || new Set(value.scopes).size !== value.scopes.length) return false;
  if (value.scopes.some((item) => typeof item !== "string" || !/^(?:*|[a-z][a-z0-9-]{0,62}:(?:*|[a-z][a-z0-9-]{0,62}))$/.test(item))) return false;
  if (!Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)) return false;
  if (value.issuedAt > now + 5 || value.expiresAt <= now || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > 120) return false;
  return validRequestBinding(value.request);
}
function validRequestBinding(value: ActorRequestBinding): boolean {
  if (!isRecord(value) || typeof value.method !== "string" || !/^[A-Z]{1,12}$/.test(value.method)) return false;
  if (typeof value.path !== "string" || !value.path.startsWith("/api/v1/private/market-agent/")) return false;
  return typeof value.bodyHash === "string" && /^sha256:[a-f0-9]{64}$/.test(value.bodyHash);
}
function sameRequestBinding(left: ActorRequestBinding, right: ActorRequestBinding): boolean {
  return left.method === right.method && left.path === right.path && left.bodyHash === right.bodyHash;
}
function boundedString(value: unknown): boolean { return typeof value === "string" && value.length > 0 && value.length <= 512; }
function validateObservation(value: unknown, path: string, evidenceIds: Set<string>, issues: string[]) {
  if (!isRecord(value)) { issues.push(`${path} must be an object`); return; }
  if (typeof value.id !== "string" || !value.id) issues.push(`${path}.id is invalid`);
  if (!oneOf(value.class, ["fact", "inference", "unknown"])) issues.push(`${path}.class is invalid`);
  if (!oneOf(value.importance, ["high", "medium", "low"])) issues.push(`${path}.importance is invalid`);
  for (const key of ["title", "explanation"] as const) if (typeof value[key] !== "string" || value[key].length > 3000) issues.push(`${path}.${key} is invalid`);
  if (!Array.isArray(value.evidenceIds) || value.evidenceIds.length === 0 || value.evidenceIds.some((id) => typeof id !== "string" || !evidenceIds.has(id))) issues.push(`${path}.evidenceIds must reference sealed evidence`);
  if (value.class === "inference" && typeof value.explanation === "string" && !/[?？]|可能|或许|倾向|likely|may|could/i.test(value.explanation)) issues.push(`${path}.inference must use uncertainty language`);
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean { if (left.length !== right.length) return false; let difference = 0; for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index]; return difference === 0; }
function base64UrlEncode(value: Uint8Array): string { let binary = ""; for (const byte of value) binary += String.fromCharCode(byte); return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function base64UrlDecode(value: string): Uint8Array { const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="); return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)); }
function hex(value: Uint8Array): string { return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

export type { MarketSnapshot };
