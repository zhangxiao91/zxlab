import { describe, expect, it } from "vitest";
import type { CandidateSignal, GeneratedBriefingDraft } from "@zxlab/signal-schema";
import { assertEditionQuality, selectUniqueEditionCandidates } from "../src/services/edition-quality";
import type { StoryDossier } from "../src/services/story-context";

function candidate(id: string, sourceId: string): CandidateSignal {
  return {
    id,
    source: { sourceId, sourceName: sourceId, sourceType: "rss", externalId: id },
    categoryHint: "ai-engineering",
    title: `Candidate ${id}`,
    url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
    summary: `Summary ${id}`,
    fetchedAt: "2026-08-10T00:00:00.000Z",
    tags: ["test"],
    contentHash: id,
    metadata: {},
    collectionRunId: "quality-test",
    status: "eligible",
  };
}

function draft(sourceIds: string[][]): GeneratedBriefingDraft {
  return {
    title: "Quality test",
    summary: "A deterministic quality-gate fixture.",
    longTermThreads: [],
    items: sourceIds.map((ids, index) => ({
      itemType: index === 0 ? "lead" : "brief",
      category: "ai-engineering",
      title: `Item ${index + 1}`,
      lede: "Lede",
      nutGraf: "Nut graf",
      keyFacts: ["Fact"],
      ...(index === 0 ? {
        broaderContext: "Context",
        counterpoint: "Counterpoint",
        watchNext: "Watch next",
      } : {}),
      implications: "Implications",
      importance: 70,
      confidence: 80,
      sourceIds: ids,
    })),
  };
}

function dossier(id: string, currentCandidateIds: string[]): StoryDossier {
  return {
    id,
    anchorCandidateId: currentCandidateIds[0]!,
    currentCandidateIds,
    historicalSignals: [],
    priorCoverage: [],
  };
}

describe("edition quality", () => {
  it("selects one deterministic representative for each independent story", () => {
    const first = candidate("first", "publisher-alpha");
    const sameDossier = candidate("same-dossier", "publisher-beta");
    const sameUrl = { ...candidate("same-url", "publisher-beta"), canonicalUrl: first.canonicalUrl };
    const sameHash = { ...candidate("same-hash", "publisher-gamma"), contentHash: first.contentHash };
    const sameTitle = { ...candidate("same-title", "publisher-delta"), title: "  CANDIDATE FIRST!  " };
    const independent = candidate("independent", "publisher-epsilon");

    expect(selectUniqueEditionCandidates({
      candidates: [first, sameDossier, sameUrl, sameHash, sameTitle, independent],
      storyDossiers: [dossier("story-first", [first.id, sameDossier.id])],
    }).map((value) => value.id)).toEqual(["first", "independent"]);
  });

  it("prefers a non-release representative inside each equivalent story", () => {
    const dossierRelease = candidate("dossier-release", "cloudflare-developer-platform");
    const dossierNews = candidate("dossier-news", "mit-technology-review");
    const urlRelease = candidate("url-release", "github-openai-node-releases");
    const urlNews = {
      ...candidate("url-news", "the-verge-ai"),
      canonicalUrl: urlRelease.canonicalUrl,
    };

    expect(selectUniqueEditionCandidates({
      candidates: [dossierRelease, dossierNews, urlRelease, urlNews],
      storyDossiers: [dossier("story-with-news", [dossierRelease.id, dossierNews.id])],
      limit: 2,
    }).map((value) => value.id)).toEqual(["dossier-news", "url-news"]);
  });

  it("balances non-release families across equivalent story components", () => {
    const primary = Array.from({ length: 6 }, (_, index) => candidate(`primary-${index + 1}`, "mit-technology-review"));
    const alternatives = [
      candidate("alternative-1", "the-verge-ai"),
      candidate("alternative-2", "techcrunch-ai"),
      candidate("alternative-3", "hn-ai-engineering"),
      candidate("alternative-4", "arxiv-agent-infra"),
      candidate("alternative-5", "producthunt-ai-devtools"),
      candidate("alternative-6", "linuxdo-develop"),
    ];
    const candidates = primary.flatMap((value, index) => [value, alternatives[index]!]);
    const selected = selectUniqueEditionCandidates({
      candidates,
      storyDossiers: primary.map((value, index) => dossier(`balanced-story-${index + 1}`, [value.id, alternatives[index]!.id])),
      limit: 6,
    });
    const familyCounts = selected.reduce<Record<string, number>>((counts, value) => {
      const family = value.source.sourceId;
      counts[family] = (counts[family] ?? 0) + 1;
      return counts;
    }, {});

    expect(selected).toHaveLength(6);
    expect(Math.max(...Object.values(familyCounts))).toBeLessThanOrEqual(2);
  });

  it("recovers an earlier family choice when constrained stories need its capacity", () => {
    const flexibleAlpha = candidate("flexible-alpha", "publisher-alpha");
    const flexibleGamma = candidate("flexible-gamma", "publisher-gamma");
    const gammaOnly = candidate("gamma-only", "publisher-gamma");
    const betaOne = candidate("beta-1", "publisher-beta");
    const betaTwo = candidate("beta-2", "publisher-beta");
    const alphaOne = candidate("alpha-1", "publisher-alpha");
    const alphaTwo = candidate("alpha-2", "publisher-alpha");
    const candidates = [
      flexibleAlpha, flexibleGamma, gammaOnly, betaOne, betaTwo, alphaOne, alphaTwo,
    ];

    const selected = selectUniqueEditionCandidates({
      candidates,
      storyDossiers: [
        dossier("story-flexible", [flexibleAlpha.id, flexibleGamma.id]),
        dossier("story-gamma", [gammaOnly.id]),
        dossier("story-beta-1", [betaOne.id]),
        dossier("story-beta-2", [betaTwo.id]),
        dossier("story-alpha-1", [alphaOne.id]),
        dossier("story-alpha-2", [alphaTwo.id]),
      ],
      limit: 6,
    });

    expect(selected.map((value) => value.id)).toEqual([
      "flexible-gamma", "gamma-only", "beta-1", "beta-2", "alpha-1", "alpha-2",
    ]);
  });

  it("uses diverse source families when a capped deterministic selection is feasible", () => {
    const candidates = [
      candidate("alpha-1", "publisher-alpha"),
      candidate("alpha-2", "publisher-alpha"),
      candidate("alpha-3", "publisher-alpha"),
      candidate("beta-1", "publisher-beta"),
      candidate("gamma-1", "publisher-gamma"),
      candidate("delta-1", "publisher-delta"),
      candidate("epsilon-1", "publisher-epsilon"),
    ];

    expect(selectUniqueEditionCandidates({
      candidates,
      storyDossiers: candidates.map((value) => dossier(`story-${value.id}`, [value.id])),
      limit: 6,
    }).map((value) => value.id)).toEqual([
      "alpha-1", "alpha-2", "beta-1", "gamma-1", "delta-1", "epsilon-1",
    ]);
  });

  it("groups configured sibling feeds into one auditable source family", () => {
    const candidates = [
      candidate("linuxdo-develop-1", "linuxdo-develop"),
      candidate("linuxdo-news-1", "linuxdo-news"),
      candidate("linuxdo-resource-1", "linuxdo-resource"),
      candidate("mit-1", "mit-technology-review"),
      candidate("verge-1", "the-verge-ai"),
      candidate("hn-1", "hn-ai-engineering"),
      candidate("techcrunch-1", "techcrunch-ai"),
    ];

    expect(() => assertEditionQuality({
      draft: draft(candidates.slice(0, 6).map((value) => [value.id])),
      candidates,
      storyDossiers: candidates.map((value) => dossier(`story-${value.id}`, [value.id])),
    })).toThrow(/source family linuxdo.*3\/6.*maximum 2/i);
  });

  it("enforces the final release-note invariant from each item's primary source", () => {
    const candidates = [
      candidate("release-1", "github-google-genai-js-releases"),
      candidate("release-2", "github-openai-node-releases"),
      candidate("release-3", "anthropic-official-updates"),
      candidate("news-1", "mit-technology-review"),
      candidate("news-2", "the-verge-ai"),
      candidate("news-3", "techcrunch-ai"),
    ];

    expect(() => assertEditionQuality({
      draft: draft(candidates.map((value) => [value.id])),
      candidates,
      storyDossiers: candidates.map((value) => dossier(`story-${value.id}`, [value.id])),
    })).toThrow(/3\/6 routine release-note items.*maximum 2/i);

    expect(() => assertEditionQuality({
      draft: draft([["release-1"]]),
      candidates,
      storyDossiers: [dossier("story-release-1", ["release-1"])],
    })).toThrow(/1\/1 routine release-note items.*maximum 0/i);
  });

  it("enforces source-policy edition quotas without relaxing them", () => {
    const cloudflare = [
      { ...candidate("cf-1", "cloudflare-developer-platform"), title: "Breaking change to Workers bindings" },
      { ...candidate("cf-2", "github-workers-sdk-releases"), title: "Security vulnerability fixed in Workers SDK" },
    ];
    const productHunt = [
      candidate("ph-1", "producthunt-ai-devtools"),
      candidate("ph-2", "producthunt-ai-devtools"),
      candidate("ph-3", "producthunt-ai-devtools"),
    ];
    const reporting = Array.from({ length: 5 }, (_, index) => candidate(`news-${index}`, `publisher-${index}`));
    const candidates = [...cloudflare, ...productHunt, ...reporting];
    const storyDossiers = candidates.map((value) => dossier(`story-${value.id}`, [value.id]));

    expect(() => assertEditionQuality({
      draft: draft([["cf-1"], ["cf-2"], ["news-0"], ["news-1"], ["news-2"], ["news-3"]]),
      candidates,
      storyDossiers,
    })).toThrow(/source family cloudflare.*2.*maximum 1/i);

    expect(() => assertEditionQuality({
      draft: draft([["news-0"], ["ph-1"], ["ph-2"], ["ph-3"], ["news-1"], ["news-2"]]),
      candidates,
      storyDossiers,
    })).toThrow(/source family producthunt.*3.*maximum 2/i);

    const selected = selectUniqueEditionCandidates({ candidates, storyDossiers, limit: 8 });
    expect(selected.filter((value) => value.source.sourceId.startsWith("cloudflare-") || value.source.sourceId === "github-workers-sdk-releases")).toHaveLength(1);
    expect(selected.filter((value) => value.source.sourceId === "producthunt-ai-devtools")).toHaveLength(2);
  });

  it("rejects a Product Hunt-only lead unless independent evidence supports it", () => {
    const ph = candidate("ph-lead", "producthunt-ai-devtools");
    const independent = candidate("independent", "publisher-independent");

    expect(() => assertEditionQuality({
      draft: draft([[ph.id], [independent.id]]),
      candidates: [ph, independent],
      storyDossiers: [dossier("story-ph", [ph.id]), dossier("story-independent", [independent.id])],
    })).toThrow(/Product Hunt-only lead.*independent/i);

    expect(assertEditionQuality({
      draft: draft([[ph.id, independent.id]]),
      candidates: [ph, independent],
      storyDossiers: [dossier("story-supported", [ph.id, independent.id])],
    }).items).toHaveLength(1);
  });

  it("rejects unrelated candidates packed into one item to bypass family quotas", () => {
    const candidates = [
      { ...candidate("cf-1", "cloudflare-developer-platform"), title: "Breaking change to Workers bindings" },
      { ...candidate("cf-2", "github-workers-sdk-releases"), title: "Security vulnerability in Workers SDK" },
      candidate("ph-1", "producthunt-ai-devtools"),
      candidate("independent", "publisher-independent"),
    ];

    for (const sourceIds of [["cf-1", "cf-2"], ["ph-1", "independent"]]) {
      expect(() => assertEditionQuality({
        draft: draft([sourceIds]),
        candidates,
        storyDossiers: candidates.map((value) => dossier(`story-${value.id}`, [value.id])),
      })).toThrow(/unrelated story components/i);
    }
  });

  it("selects the largest deterministic fallback subset that satisfies the release-note invariant", () => {
    const candidates = [
      candidate("release-0", "github-openai-node-releases"),
      candidate("release-1", "github-anthropic-sdk-typescript-releases"),
      candidate("release-2", "github-google-genai-js-releases"),
      candidate("release-3", "anthropic-official-updates"),
      candidate("news-1", "mit-technology-review"),
      candidate("news-2", "the-verge-ai"),
      candidate("news-3", "techcrunch-ai"),
      candidate("news-4", "hn-ai-engineering"),
    ];
    const selected = selectUniqueEditionCandidates({
      candidates,
      storyDossiers: candidates.map((value) => dossier(`story-${value.id}`, [value.id])),
      limit: 6,
    });

    expect(selected).toHaveLength(6);
    expect(selected.filter((value) => [
      "github-openai-node-releases",
      "github-anthropic-sdk-typescript-releases",
      "github-google-genai-js-releases",
      "anthropic-official-updates",
    ].includes(value.source.sourceId))).toHaveLength(2);
    expect(selectUniqueEditionCandidates({
      candidates: candidates.slice(0, 4),
      storyDossiers: candidates.slice(0, 4).map((value) => dossier(`story-${value.id}`, [value.id])),
      limit: 4,
    })).toEqual([]);
  });

  it("rejects one candidate source reused by two briefing items", () => {
    const candidates = [candidate("report-a", "publisher-a"), candidate("report-b", "publisher-b")];

    expect(() => assertEditionQuality({
      draft: draft([["report-a"], ["report-a"]]),
      candidates,
      storyDossiers: [dossier("story-a", ["report-a"]), dossier("story-b", ["report-b"])],
    })).toThrow(/report-a.*more than one item/i);
  });

  it("rejects duplicate story identities split across model-authored items", () => {
    const original = candidate("report-a", "publisher-a");
    const duplicateUrl = { ...candidate("report-b", "publisher-b"), canonicalUrl: original.canonicalUrl };
    const duplicateHash = { ...candidate("report-c", "publisher-c"), contentHash: original.contentHash };
    const duplicateTitle = { ...candidate("report-d", "publisher-d"), title: "  CANDIDATE REPORT-A!  " };

    for (const [duplicate, identity] of [
      [duplicateUrl, /canonical URL/i],
      [duplicateHash, /content hash/i],
      [duplicateTitle, /normalized title/i],
    ] as const) {
      expect(() => assertEditionQuality({
        draft: draft([[original.id], [duplicate.id]]),
        candidates: [original, duplicate],
        storyDossiers: [],
      })).toThrow(identity);
    }
  });

  it("rejects one dossier split into separate briefing items", () => {
    const candidates = [candidate("report-a", "publisher-a"), candidate("report-b", "publisher-b")];

    expect(() => assertEditionQuality({
      draft: draft([["report-a"], ["report-b"]]),
      candidates,
      storyDossiers: [dossier("story-shared", ["report-a", "report-b"])],
    })).toThrow(/story-shared.*more than one item/i);
  });

  it("rejects source-family concentration when diverse independent stories can replace it", () => {
    const candidates = [
      candidate("alpha-1", "publisher-alpha"),
      candidate("alpha-2", "publisher-alpha"),
      candidate("alpha-3", "publisher-alpha"),
      candidate("beta-1", "publisher-beta"),
      candidate("gamma-1", "publisher-gamma"),
      candidate("delta-1", "publisher-delta"),
      candidate("epsilon-1", "publisher-epsilon"),
    ];
    const storyDossiers = candidates.map((value) => dossier(`story-${value.id}`, [value.id]));

    expect(() => assertEditionQuality({
      draft: draft([["alpha-1"], ["alpha-2"], ["alpha-3"], ["beta-1"], ["gamma-1"], ["delta-1"]]),
      candidates,
      storyDossiers,
    })).toThrow(/publisher-alpha.*3\/6.*maximum 2/i);
  });

  it("allows unavoidable concentration in a narrow candidate pool", () => {
    const candidates = [
      candidate("alpha-1", "publisher-alpha"),
      candidate("alpha-2", "publisher-alpha"),
      candidate("alpha-3", "publisher-alpha"),
      candidate("beta-1", "publisher-beta"),
      candidate("gamma-1", "publisher-gamma"),
      candidate("delta-1", "publisher-delta"),
    ];

    expect(assertEditionQuality({
      draft: draft([["alpha-1"], ["alpha-2"], ["alpha-3"], ["beta-1"], ["gamma-1"], ["delta-1"]]),
      candidates,
      storyDossiers: candidates.map((value) => dossier(`story-${value.id}`, [value.id])),
    }).items).toHaveLength(6);
  });

  it("does not claim family diversity that would require too many release-note stories", () => {
    const candidates = [
      candidate("alpha-1", "publisher-alpha"),
      candidate("alpha-2", "publisher-alpha"),
      candidate("alpha-3", "publisher-alpha"),
      candidate("alpha-4", "publisher-alpha"),
      candidate("alpha-5", "publisher-alpha"),
      candidate("beta-1", "publisher-beta"),
      candidate("release-1", "github-openai-node-releases"),
      candidate("release-2", "anthropic-official-updates"),
      candidate("release-3", "cloudflare-developer-platform"),
    ];

    expect(assertEditionQuality({
      draft: draft(candidates.slice(0, 6).map((value) => [value.id])),
      candidates,
      storyDossiers: candidates.map((value) => dossier(`story-${value.id}`, [value.id])),
    }).items).toHaveLength(6);
  });
});
