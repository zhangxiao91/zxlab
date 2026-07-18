export const briefingDraftJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" }, summary: { type: "string" },
    items: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, properties: {
      category: { type: "string", enum: ["ai-engineering", "markets", "zxlab"] }, title: { type: "string" }, summary: { type: "string" },
      whatChanged: { type: "string" }, whyItMatters: { type: "string" }, suggestedAction: { type: "string" },
      importance: { type: "number", minimum: 0, maximum: 100 }, confidence: { type: "number", minimum: 0, maximum: 100 },
      sourceIds: { type: "array", minItems: 1, items: { type: "string" } },
    }, required: ["category", "title", "summary", "whyItMatters", "importance", "confidence", "sourceIds"] } },
  }, required: ["title", "summary", "items"],
} as const;

export const annotationReplyJsonSchema = { type: "object", additionalProperties: false, properties: { reply: { type: "string" } }, required: ["reply"] } as const;

export const memoryCandidateJsonSchema = { type: "object", additionalProperties: false, properties: {
  shouldRemember: { type: "boolean" }, scope: { type: "string", enum: ["discussion", "project", "preference", "belief"] },
  content: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 }, reason: { type: "string" },
}, required: ["shouldRemember"] } as const;

export const editorialDecisionJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decisions: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidateId: { type: "string" },
          decision: { type: "string", enum: ["keep", "drop", "merge"] },
          category: { type: "string", enum: ["ai-engineering", "zxlab", "markets", "uncategorized"] },
          relevance: { type: "number", minimum: 0, maximum: 100 },
          novelty: { type: "number", minimum: 0, maximum: 100 },
          actionability: { type: "number", minimum: 0, maximum: 100 },
          sourceQuality: { type: "number", minimum: 0, maximum: 100 },
          reason: { type: "string" },
          relatedMemoryIds: { type: "array", items: { type: "string" } },
          mergeTargetCandidateId: { type: "string" },
        },
        required: ["candidateId", "decision", "category", "relevance", "novelty", "actionability", "sourceQuality", "reason", "relatedMemoryIds"],
      },
    },
  },
  required: ["decisions"],
} as const;
