import type { JWTPayload } from "jose";
import { RiskReviewError, type RiskReviewEnv, verifyCloudflareAccess } from "../risk/review.ts";

export type AccessActorKind = "human" | "agent";

export interface AccessActor {
  kind: AccessActorKind;
  subject: string;
  ownerSubject: string;
  actorId: string;
  scopes: string[];
  email?: string;
}

export interface AccessActorEnv extends RiskReviewEnv {
  /**
   * JSON secret mapping Cloudflare Access service-token subjects to their
   * delegated ZXLab owner and explicit route scopes.
   */
  ZX_ACCESS_SERVICE_ACTORS?: string;
  /** Additive JSON actor mapping for independently managed machine credentials. */
  ZX_ACCESS_ADDITIONAL_SERVICE_ACTORS?: string;
  /** JSON array of additional Access audiences accepted only by private proxy routes. */
  ZX_PRIVATE_ACCESS_ADDITIONAL_AUDS?: string;
}

export interface AccessActorDependencies {
  verifyAccess?: typeof verifyCloudflareAccess;
}

interface ConfiguredServiceActor {
  clientId: string;
  actorId: string;
  ownerSubject: string;
  scopes: string[];
}

interface PrivateAccessAudienceConfiguration {
  audiences: string[] | undefined;
  machineAudiences: string[];
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,160}$/;
const scope = /^(?:\*|[a-z][a-z0-9-]{0,62}:(?:\*|[a-z][a-z0-9-]{0,62}))$/;

/**
 * Resolves the verified Cloudflare claim into the only actor shape private
 * routes need. Email is display-only; stable subjects own data and agents are
 * explicitly delegated to an owner through a server-side secret.
 */
export async function resolveAccessActor(request: Request, env: AccessActorEnv, dependencies: AccessActorDependencies = {}): Promise<AccessActor> {
  const audienceConfiguration = privateAccessAudiences(env);
  const claims = await (dependencies.verifyAccess ?? verifyCloudflareAccess)(request, env, audienceConfiguration.audiences ? { audiences: audienceConfiguration.audiences } : undefined);
  const serviceClientId = stringClaim(claims, "common_name");
  const machine = Boolean(serviceClientId) || serviceTokenHeadersPresent(request) || hasMachineAudience(claims, audienceConfiguration.machineAudiences);
  const configured = configuredServiceActors(
    env.ZX_ACCESS_SERVICE_ACTORS,
    env.ZX_ACCESS_ADDITIONAL_SERVICE_ACTORS,
  );
  if (machine) {
    if (!serviceClientId) {
      throw new RiskReviewError("ACCESS_SERVICE_ACTOR_IDENTITY_MISSING", "This machine Access assertion has no service-token identity.", 403);
    }
    const actor = configured.get(serviceClientId);
    if (!actor) {
      throw new RiskReviewError("ACCESS_SERVICE_ACTOR_UNREGISTERED", "This machine identity is not registered for ZXLab access.", 403);
    }
    return {
      kind: "agent",
      subject: `service:${serviceClientId}`,
      ownerSubject: actor.ownerSubject,
      actorId: actor.actorId,
      scopes: actor.scopes,
    };
  }

  const subject = stringClaim(claims, "sub");
  if (!subject) throw new RiskReviewError("ACCESS_IDENTITY_MISSING", "Cloudflare Access identity is incomplete.", 403);
  const email = stringClaim(claims, "email");
  return {
    kind: "human",
    subject,
    ownerSubject: subject,
    actorId: `access:${subject}`,
    scopes: ["*"],
    ...(email ? { email } : {}),
  };
}

function privateAccessAudiences(env: AccessActorEnv): PrivateAccessAudienceConfiguration {
  const primary = env.RISK_ACCESS_AUD?.trim();
  if (!primary) return { audiences: undefined, machineAudiences: [] };
  const raw = env.ZX_PRIVATE_ACCESS_ADDITIONAL_AUDS?.trim();
  if (!raw) return { audiences: [primary], machineAudiences: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    throw new RiskReviewError("ACCESS_AUDIENCES_INVALID", "Private Access audience configuration is invalid.", 503, { cause });
  }
  if (!Array.isArray(parsed) || parsed.length > 15) throw new RiskReviewError("ACCESS_AUDIENCES_INVALID", "Private Access audience configuration is invalid.", 503);
  const values = [primary, ...parsed.map((item) => typeof item === "string" ? item.trim() : "")];
  if (values.some((item) => !item || item.length > 512 || /\s/.test(item)) || new Set(values).size !== values.length) {
    throw new RiskReviewError("ACCESS_AUDIENCES_INVALID", "Private Access audience configuration is invalid.", 503);
  }
  return { audiences: values, machineAudiences: values.slice(1) };
}

function hasMachineAudience(claims: JWTPayload, machineAudiences: string[]): boolean {
  const claim = claims.aud;
  const audiences = Array.isArray(claim) ? claim : typeof claim === "string" ? [claim] : [];
  return machineAudiences.some((candidate) => audiences.includes(candidate));
}

export function actorHasScope(actor: AccessActor, required: string): boolean {
  if (actor.scopes.includes("*") || actor.scopes.includes(required)) return true;
  const separator = required.indexOf(":");
  return separator > 0 && actor.scopes.includes(`${required.slice(0, separator)}:*`);
}

export function requireActorScope(actor: AccessActor, required: string): void {
  if (!actorHasScope(actor, required)) {
    throw new RiskReviewError("ACCESS_SCOPE_REQUIRED", "This identity is not allowed to access the requested private route.", 403);
  }
}

function configuredServiceActors(...rawValues: Array<string | undefined>): Map<string, ConfiguredServiceActor> {
  const parsed = rawValues.flatMap(parseServiceActorArray);
  if (parsed.length > 64) throw invalidConfiguration();
  const actors = new Map<string, ConfiguredServiceActor>();
  for (const entry of parsed) {
    if (!isRecord(entry)) throw invalidConfiguration();
    const clientId = identifierValue(entry.clientId);
    const actorId = identifierValue(entry.actorId);
    const ownerSubject = subjectValue(entry.ownerSubject);
    const scopes = scopeValues(entry.scopes);
    if (!clientId || !actorId || !ownerSubject || !scopes || actors.has(clientId)) throw invalidConfiguration();
    actors.set(clientId, { clientId, actorId, ownerSubject, scopes });
  }
  return actors;
}

function parseServiceActorArray(raw: string | undefined): unknown[] {
  const value = raw?.trim();
  if (!value) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (cause) {
    throw invalidConfiguration(cause);
  }
  if (!Array.isArray(parsed)) throw invalidConfiguration();
  return parsed;
}

function invalidConfiguration(cause?: unknown): RiskReviewError {
  return new RiskReviewError("ACCESS_SERVICE_ACTORS_INVALID", "Machine access configuration is invalid.", 503, cause ? { cause } : undefined);
}

function stringClaim(claims: JWTPayload, key: "sub" | "email" | "common_name"): string | undefined {
  const value = claims[key];
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function serviceTokenHeadersPresent(request: Request): boolean {
  if (request.headers.get("cf-access-client-id") || request.headers.get("cf-access-client-secret")) return true;
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization?.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(authorization) as unknown;
    return isRecord(parsed)
      && typeof parsed["cf-access-client-id"] === "string"
      && typeof parsed["cf-access-client-secret"] === "string";
  } catch {
    return false;
  }
}

function identifierValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return identifier.test(normalized) ? normalized : undefined;
}

function subjectValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 512 ? normalized : undefined;
}

function scopeValues(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  const values = value.map((item) => typeof item === "string" ? item.trim() : "");
  return values.every((item) => scope.test(item)) && new Set(values).size === values.length ? values : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
