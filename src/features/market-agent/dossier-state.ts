export function dossierMutationKey(
  keys: Map<string, string>,
  proposalId: string,
  commandSignature: string,
  create: () => string = () => crypto.randomUUID(),
): string {
  const identity = `${proposalId}:${commandSignature}`;
  const existing = keys.get(identity);
  if (existing) return existing;
  const key = `dossier:${proposalId}:${create()}`;
  keys.set(identity, key);
  return key;
}

export function clearDossierMutationKey(
  keys: Map<string, string>,
  proposalId: string,
  commandSignature: string,
): void {
  keys.delete(`${proposalId}:${commandSignature}`);
}

export function dossierAlertCommandSignature(input: {
  template: "new_reporting_period" | "metric_threshold_crossing";
  deltaId: string;
  field?: "value" | "yoy" | "qoq";
  operator?: "crosses_above" | "crosses_below";
  threshold?: string;
}): string {
  return input.template === "new_reporting_period"
    ? `alert:${input.template}:${input.deltaId}`
    : `alert:${input.template}:${input.deltaId}:${input.field}:${input.operator}:${input.threshold}`;
}
