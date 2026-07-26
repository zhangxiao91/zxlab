export const briefingDraftJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" }, summary: { type: "string" },
    longTermThreads: { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, properties: {
      title: { type: "string" }, description: { type: "string" },
      category: { type: "string", enum: ["ai-engineering", "markets", "zxlab"] },
      dossierIds: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
    }, required: ["title", "description", "category", "dossierIds"] } },
    items: { type: "array", minItems: 1, maxItems: 6, items: { type: "object", additionalProperties: false, properties: {
      itemType: { type: "string", enum: ["lead", "brief"] },
      category: { type: "string", enum: ["ai-engineering", "markets", "zxlab"] }, title: { type: "string" },
      lede: { type: "string" }, nutGraf: { type: "string" }, keyFacts: { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } },
      broaderContext: { type: "string" }, implications: { type: "string" }, counterpoint: { type: "string" },
      watchNext: { type: "string" }, zxlabRelevance: { type: "string" },
      importance: { type: "number", minimum: 0, maximum: 100 }, confidence: { type: "number", minimum: 0, maximum: 100 },
      sourceIds: { type: "array", minItems: 1, items: { type: "string" } },
    }, required: ["itemType", "category", "title", "lede", "nutGraf", "keyFacts", "implications", "importance", "confidence", "sourceIds"] } },
  }, required: ["title", "summary", "longTermThreads", "items"],
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
