export interface QuotaUsage {
  uploads: number;
  bytes: number;
}

export function evaluateQuota(
  state: QuotaUsage,
  requestedBytes: number,
  uploadLimit: number,
  byteLimit: number
): "accepted" | "count" | "bytes" {
  if (state.uploads >= uploadLimit) return "count";
  if (state.bytes + requestedBytes > byteLimit) return "bytes";
  return "accepted";
}
