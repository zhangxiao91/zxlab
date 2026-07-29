import { parse as parseYaml } from "yaml";

export const memoryNamespaces = ["global", "briefing", "markets", "coding", "zxlab"] as const;
export const memoryKinds = ["preference", "fact", "decision", "summary"] as const;

export type MemoryNamespace = typeof memoryNamespaces[number];
export type MemoryKind = typeof memoryKinds[number];

export interface MemoryImportItem {
  namespace: MemoryNamespace;
  kind: MemoryKind;
  content: string;
  importance: number;
  confidence: number;
  sourceType: string;
  sourceId: string;
}

export interface MemoryManifest {
  metadata: {
    profileName: string;
    version: string;
    updatedAt?: string;
  };
  memories: MemoryImportItem[];
}

export interface RemoteMemory extends MemoryImportItem {
  id: string;
  status: "active" | "superseded" | "forgotten";
}

export interface ImportPlanEntry {
  action: "create" | "update" | "skip";
  desired: MemoryImportItem;
  existing?: RemoteMemory;
  changes: string[];
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown, field: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as UnknownRecord;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  const result = value.trim();
  if (result.length > max) throw new Error(`${field} must be at most ${max} characters`);
  return result;
}

function score(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a number between 0 and 1`);
  }
  return value;
}

function oneOf<T extends readonly string[]>(value: unknown, values: T, field: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${field} is invalid`);
  return value as T[number];
}

export function canonicalContent(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/\s*([,.;:!?，。；：！？、])\s*/g, "$1")
    .trim();
}

export function parseMemoryManifest(source: string): MemoryManifest {
  const root = record(parseYaml(source), "manifest");
  const metadata = record(root.metadata, "metadata");
  if (!Array.isArray(root.memories) || root.memories.length === 0) throw new Error("memories must be a non-empty array");

  const profileName = text(metadata.profile_name ?? metadata.profileName, "metadata.profile_name", 100);
  const version = text(metadata.version, "metadata.version", 40);
  const sourceId = `${profileName}:${version}${metadata.updated_at || metadata.updatedAt ? `:${text(metadata.updated_at ?? metadata.updatedAt, "metadata.updated_at", 40)}` : ""}`;
  const seen = new Set<string>();

  const memories = root.memories.map((raw, index): MemoryImportItem => {
    const item = record(raw, `memories[${index}]`);
    const content = text(item.content, `memories[${index}].content`, 8_000);
    const namespace = oneOf(item.namespace, memoryNamespaces, `memories[${index}].namespace`);
    const kind = oneOf(item.kind, memoryKinds, `memories[${index}].kind`);
    const key = `${namespace}\u0000${kind}\u0000${canonicalContent(content)}`;
    if (seen.has(key)) throw new Error(`memories[${index}] duplicates another manifest entry`);
    seen.add(key);
    return {
      namespace,
      kind,
      content,
      importance: score(item.importance, `memories[${index}].importance`),
      confidence: score(item.confidence, `memories[${index}].confidence`),
      sourceType: text(item.source_type ?? item.sourceType ?? "user_import", `memories[${index}].source_type`, 80),
      sourceId: text(item.source_id ?? item.sourceId ?? sourceId, `memories[${index}].source_id`, 160),
    };
  });

  return {
    metadata: {
      profileName,
      version,
      updatedAt: metadata.updated_at || metadata.updatedAt
        ? text(metadata.updated_at ?? metadata.updatedAt, "metadata.updated_at", 40)
        : undefined,
    },
    memories,
  };
}

function changedFields(existing: RemoteMemory, desired: MemoryImportItem): string[] {
  return (["namespace", "kind", "content", "importance", "confidence", "sourceType", "sourceId"] as const)
    .filter((field) => existing[field] !== desired[field]);
}

export function planMemoryImport(desired: MemoryImportItem[], remote: RemoteMemory[]): ImportPlanEntry[] {
  const active = remote.filter((item) => item.status === "active");
  return desired.map((item) => {
    const matches = active.filter((candidate) => canonicalContent(candidate.content) === canonicalContent(item.content));
    if (matches.length > 1) throw new Error(`multiple active memories match: ${item.content.slice(0, 80)}`);
    if (matches.length === 0) return { action: "create", desired: item, changes: [] };
    const existing = matches[0]!;
    const changes = changedFields(existing, item);
    return changes.length === 0
      ? { action: "skip", desired: item, existing, changes }
      : { action: "update", desired: item, existing, changes };
  });
}
