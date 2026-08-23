import { describe, expect, it } from "vitest";
import type { CandidateSignal } from "@zxlab/signal-schema";
import { findSource } from "../src/config/sources";
import { SIGNAL_SOURCE_POLICY_VERSION, signalSourcePolicy } from "../src/services/source-policy";
import { DAILY_CANDIDATE_POOL } from "../src/services/daily-signal-pipeline";
import { SIGNAL_SOURCES } from "../src/config/sources";

function candidate(id: string, sourceId: string, title: string, summary = ""): CandidateSignal {
  return {
    id,
    source: { sourceId, sourceName: sourceId, sourceType: "rss", externalId: id },
    categoryHint: "zxlab",
    title,
    summary,
    url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
    fetchedAt: "2026-08-21T00:00:00.000Z",
    tags: [],
    contentHash: id,
    metadata: {},
    collectionRunId: "policy-test",
    status: "eligible",
  };
}

describe("signal source policy v2", () => {
  it("persists explicit Cloudflare and Product Hunt registry controls", () => {
    expect(SIGNAL_SOURCE_POLICY_VERSION).toBe("signal-sources-v2");
    expect(findSource("cloudflare-developer-platform")).toMatchObject({
      collectionPriority: 40,
      maxItemsPerRun: 6,
      deliveryMode: "weekly",
      dailyCandidateQuota: 2,
      dailyEditionQuota: 1,
      materialityPolicy: "cloudflare-material-change",
    });
    expect(findSource("github-workers-sdk-releases")).toMatchObject({
      collectionPriority: 35,
      maxItemsPerRun: 4,
      deliveryMode: "weekly",
      dailyCandidateQuota: 2,
      dailyEditionQuota: 1,
    });
    expect(findSource("producthunt-ai-devtools")).toMatchObject({
      collectionPriority: 76,
      deliveryMode: "daily",
      dailyCandidateQuota: 3,
      dailyEditionQuota: 2,
      topics: [
        "Artificial Intelligence",
        "Developer Tools",
        "Productivity",
        "Personal Knowledge Management",
        "Research Tools",
        "Design Tools",
      ],
    });
  });

  it("loads the complete bounded collection run before policy preselection", () => {
    expect(DAILY_CANDIDATE_POOL).toBe(SIGNAL_SOURCES.reduce((total, source) => total + source.maxItemsPerRun, 0));
    expect(DAILY_CANDIDATE_POOL).toBeGreaterThan(200);
  });

  it("keeps routine Cloudflare updates weekly but promotes bounded material changes", () => {
    expect(signalSourcePolicy.classify(candidate(
      "routine",
      "cloudflare-developer-platform",
      "Workers runtime compatibility update",
      "Documentation and runtime behavior were updated.",
    ))).toMatchObject({ dailyEligible: false, reasonCode: "WEEKLY_ROUTINE_UPDATE", releaseNote: true });

    for (const [title, reasonCode] of [
      ["Breaking change to Workers bindings", "MATERIAL_BREAKING_CHANGE"],
      ["D1 security vulnerability CVE-2026-1234", "MATERIAL_SECURITY_CHANGE"],
      ["Workers pricing and billing changes", "MATERIAL_PRICING_CHANGE"],
      ["Free plan quota reduced", "MATERIAL_QUOTA_REDUCTION"],
      ["Regional outage causes availability regression", "MATERIAL_AVAILABILITY_REGRESSION"],
    ] as const) {
      expect(signalSourcePolicy.classify(candidate(reasonCode, "cloudflare-developer-platform", title)))
        .toMatchObject({ dailyEligible: true, reasonCode, dailyCandidateQuota: 2, dailyEditionQuota: 1, releaseNote: false });
    }
  });

  it("does not promote negated or documentation-only Cloudflare mentions", () => {
    for (const title of [
      "Workers release with no breaking changes",
      "Workers pricing remains unchanged",
      "Security documentation update",
      "D1 quota was not reduced",
    ]) {
      expect(signalSourcePolicy.classify(candidate(title, "cloudflare-developer-platform", title)))
        .toMatchObject({ dailyEligible: false, reasonCode: "WEEKLY_ROUTINE_UPDATE" });
    }
  });
});
