import { SignalValidationError, type CandidateSignal, type GeneratedBriefingDraft } from "@zxlab/signal-schema";
import type { StoryDossier } from "./story-context";
import { signalSourcePolicy } from "./source-policy";

export interface EditionQualityInput {
  draft: GeneratedBriefingDraft;
  candidates: CandidateSignal[];
  storyDossiers: StoryDossier[];
}

export interface UniqueEditionCandidateInput {
  candidates: CandidateSignal[];
  storyDossiers: StoryDossier[];
  limit?: number;
}

function normalizedUrl(candidate: CandidateSignal): string {
  const raw = candidate.canonicalUrl || candidate.url;
  try {
    const url = new URL(raw);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return raw.normalize("NFKC").trim().toLowerCase().replace(/\/+$/, "");
  }
}

function normalizedTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
}

function dossiersByCandidate(storyDossiers: StoryDossier[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const dossier of storyDossiers) {
    for (const candidateId of dossier.currentCandidateIds) {
      const dossierIds = result.get(candidateId) ?? [];
      dossierIds.push(dossier.id);
      result.set(candidateId, dossierIds);
    }
  }
  return result;
}

interface StoryComponent {
  order: number;
  releaseOnly: boolean;
  candidateIndexes: number[];
  candidateIndexesByFamily: Map<string, number[]>;
}

function editionFamilyCaps(candidates: CandidateSignal[]): Map<string, number> {
  const caps = new Map<string, number>();
  for (const candidate of candidates) {
    const classification = signalSourcePolicy.classify(candidate);
    caps.set(classification.family, Math.min(
      caps.get(classification.family) ?? classification.dailyEditionQuota,
      classification.dailyEditionQuota,
    ));
  }
  return caps;
}

function storyComponents(input: UniqueEditionCandidateInput): StoryComponent[] {
  const candidateDossiers = dossiersByCandidate(input.storyDossiers);
  const parents = input.candidates.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const next = parents[index]!;
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const firstIndexByIdentity = new Map<string, number>();
  input.candidates.forEach((candidate, index) => {
    const contentHash = candidate.contentHash.trim().toLowerCase();
    const title = normalizedTitle(candidate.title);
    const identities = [
      ...(candidateDossiers.get(candidate.id) ?? []).map((dossierId) => `dossier:${dossierId}`),
      `url:${normalizedUrl(candidate)}`,
      ...(contentHash ? [`hash:${contentHash}`] : []),
      ...(title ? [`title:${title}`] : []),
    ];
    for (const identity of identities) {
      const firstIndex = firstIndexByIdentity.get(identity);
      if (firstIndex === undefined) firstIndexByIdentity.set(identity, index);
      else union(firstIndex, index);
    }
  });

  const components = new Map<number, number[]>();
  input.candidates.forEach((_, index) => {
    const root = find(index);
    const component = components.get(root) ?? [];
    component.push(index);
    components.set(root, component);
  });
  const orderedComponents = [...components.values()].sort((left, right) => left[0]! - right[0]!);
  return orderedComponents.map((indexes) => {
    const dailyIndexes = indexes.filter((index) => signalSourcePolicy.classify(input.candidates[index]!).dailyEligible);
    const nonReleaseIndexes = dailyIndexes.filter((index) => !signalSourcePolicy.isReleaseNote(input.candidates[index]!));
    const eligibleIndexes = nonReleaseIndexes.length > 0 ? nonReleaseIndexes : dailyIndexes;
    const candidateIndexesByFamily = new Map<string, number[]>();
    for (const index of eligibleIndexes) {
      const family = signalSourcePolicy.familyFor(input.candidates[index]!);
      const familyIndexes = candidateIndexesByFamily.get(family) ?? [];
      familyIndexes.push(index);
      candidateIndexesByFamily.set(family, familyIndexes);
    }
    return {
      order: indexes[0]!,
      releaseOnly: nonReleaseIndexes.length === 0,
      candidateIndexes: indexes,
      candidateIndexesByFamily,
    };
  });
}

interface FlowEdge {
  to: number;
  reverse: number;
  capacity: number;
  initialCapacity: number;
}

/**
 * Finds a recoverable component-to-family capacity matching. The two source
 * groups make release-note quota part of the same feasibility decision instead
 * of letting family diversity and release quality disagree in separate passes.
 */
function matchStoryFamilies(
  components: StoryComponent[],
  itemCount: number,
  familyCap: number,
  releaseLimit: number,
  hardFamilyCaps: ReadonlyMap<string, number>,
): Map<number, string> | undefined {
  if (itemCount === 0) return new Map();
  if (components.length < itemCount || familyCap < 1) return undefined;

  const families = new Map<string, number>();
  for (const component of components) {
    for (const family of component.candidateIndexesByFamily.keys()) {
      if (!families.has(family)) families.set(family, families.size);
    }
  }
  const totalFamilyCapacity = [...families.keys()].reduce(
    (total, family) => total + Math.min(familyCap, hardFamilyCaps.get(family) ?? familyCap),
    0,
  );
  if (totalFamilyCapacity < itemCount) return undefined;

  const sourceNode = 0;
  const nonReleaseNode = 1;
  const releaseNode = 2;
  const componentStart = 3;
  const familyStart = componentStart + components.length;
  const sinkNode = familyStart + families.size;
  const graph: FlowEdge[][] = Array.from({ length: sinkNode + 1 }, () => []);
  const addEdge = (from: number, to: number, capacity: number): FlowEdge => {
    const forward: FlowEdge = { to, reverse: graph[to]!.length, capacity, initialCapacity: capacity };
    const reverse: FlowEdge = { to: from, reverse: graph[from]!.length, capacity: 0, initialCapacity: 0 };
    graph[from]!.push(forward);
    graph[to]!.push(reverse);
    return forward;
  };

  addEdge(sourceNode, nonReleaseNode, itemCount);
  addEdge(sourceNode, releaseNode, Math.min(itemCount, Math.max(0, releaseLimit)));
  for (const [family, familyIndex] of families) {
    addEdge(familyStart + familyIndex, sinkNode, Math.min(familyCap, hardFamilyCaps.get(family) ?? familyCap));
  }

  const assignmentEdges: Array<Array<{ family: string; edge: FlowEdge }>> = [];
  components.forEach((component, componentIndex) => {
    const componentNode = componentStart + componentIndex;
    addEdge(component.releaseOnly ? releaseNode : nonReleaseNode, componentNode, 1);
    const edges: Array<{ family: string; edge: FlowEdge }> = [];
    for (const family of component.candidateIndexesByFamily.keys()) {
      edges.push({ family, edge: addEdge(componentNode, familyStart + families.get(family)!, 1) });
    }
    assignmentEdges.push(edges);
  });

  let flow = 0;
  while (flow < itemCount) {
    const parentNode = Array<number>(graph.length).fill(-1);
    const parentEdge = Array<number>(graph.length).fill(-1);
    const queue = [sourceNode];
    parentNode[sourceNode] = sourceNode;
    for (let cursor = 0; cursor < queue.length && parentNode[sinkNode] === -1; cursor += 1) {
      const node = queue[cursor]!;
      graph[node]!.forEach((edge, edgeIndex) => {
        if (edge.capacity < 1 || parentNode[edge.to] !== -1) return;
        parentNode[edge.to] = node;
        parentEdge[edge.to] = edgeIndex;
        queue.push(edge.to);
      });
    }
    if (parentNode[sinkNode] === -1) break;
    let node = sinkNode;
    let added = itemCount - flow;
    while (node !== sourceNode) {
      const previous = parentNode[node]!;
      const edge = graph[previous]![parentEdge[node]!]!;
      added = Math.min(added, edge.capacity);
      node = previous;
    }
    node = sinkNode;
    while (node !== sourceNode) {
      const previous = parentNode[node]!;
      const edge = graph[previous]![parentEdge[node]!]!;
      edge.capacity -= added;
      graph[node]![edge.reverse]!.capacity += added;
      node = previous;
    }
    flow += added;
  }
  if (flow < itemCount) return undefined;

  const assignment = new Map<number, string>();
  assignmentEdges.forEach((edges, componentIndex) => {
    const selected = edges.find(({ edge }) => edge.initialCapacity === 1 && edge.capacity === 0);
    if (selected) assignment.set(componentIndex, selected.family);
  });
  return assignment.size === itemCount ? assignment : undefined;
}

/**
 * Selects story-level representatives for deterministic generation. Identity and
 * diversity policy stay behind this in-process seam so fallback callers cannot
 * accidentally recreate candidate-level duplicate stories.
 */
export function selectUniqueEditionCandidates(input: UniqueEditionCandidateInput): CandidateSignal[] {
  const components = storyComponents(input);
  const hardFamilyCaps = editionFamilyCaps(input.candidates);
  const requestedLimit = Math.max(0, Math.min(input.limit ?? components.length, components.length));
  const nonReleaseCount = components.filter((component) => !component.releaseOnly).length;
  const releaseCount = components.length - nonReleaseCount;
  let limit = requestedLimit;
  while (limit > 0) {
    const requiredReleaseCount = Math.max(0, limit - nonReleaseCount);
    if (requiredReleaseCount <= Math.min(releaseCount, signalSourcePolicy.releaseNoteLimit(limit))) break;
    limit -= 1;
  }
  if (limit === 0) return [];

  const strictFamilyCap = limit < 3 ? limit : Math.floor(limit / 3);
  for (let familyCap = strictFamilyCap; familyCap <= limit; familyCap += 1) {
    const assignment = matchStoryFamilies(
      components,
      limit,
      familyCap,
      signalSourcePolicy.releaseNoteLimit(limit),
      hardFamilyCaps,
    );
    if (!assignment) continue;
    return [...assignment.entries()]
      .sort(([left], [right]) => components[left]!.order - components[right]!.order)
      .map(([componentIndex, family]) => {
        const candidateIndex = components[componentIndex]!.candidateIndexesByFamily.get(family)![0]!;
        return input.candidates[candidateIndex]!;
      });
  }
  return [];
}

/**
 * Applies final-edition invariants after schema parsing. It returns the same draft
 * for fluent use and throws SignalValidationError so the existing single repair
 * attempt is the only route back to publication.
 */
export function assertEditionQuality(input: EditionQualityInput): GeneratedBriefingDraft {
  const candidatesById = new Map(input.candidates.map((candidate) => [candidate.id, candidate]));
  const candidateComponent = new Map<string, number>();
  storyComponents({ candidates: input.candidates, storyDossiers: input.storyDossiers })
    .forEach((component, componentIndex) => {
      component.candidateIndexes.forEach((candidateIndex) => {
        candidateComponent.set(input.candidates[candidateIndex]!.id, componentIndex);
      });
    });
  const firstItemBySourceId = new Map<string, number>();
  const firstItemByUrl = new Map<string, number>();
  const firstItemByHash = new Map<string, number>();
  const firstItemByTitle = new Map<string, number>();
  const familyItems = new Map<string, Set<number>>();
  let releaseNoteCount = 0;

  const claimIdentity = (identity: string, label: string, itemIndex: number, firstItemByIdentity: Map<string, number>) => {
    if (!identity) return;
    const firstItem = firstItemByIdentity.get(identity);
    if (firstItem !== undefined && firstItem !== itemIndex) {
      throw new SignalValidationError(`Edition quality rejected ${label} shared by more than one item`);
    }
    firstItemByIdentity.set(identity, itemIndex);
  };

  input.draft.items.forEach((item, itemIndex) => {
    const storyComponentIds = new Set(item.sourceIds.map((sourceId) => candidateComponent.get(sourceId)));
    if (storyComponentIds.size > 1) {
      throw new SignalValidationError(
        `Edition quality rejected item ${itemIndex + 1} sources from unrelated story components`,
      );
    }
    const primaryCandidate = candidatesById.get(item.sourceIds[0]!);
    if (primaryCandidate) {
      const primaryClassification = signalSourcePolicy.classify(primaryCandidate);
      if (!primaryClassification.dailyEligible) {
        throw new SignalValidationError(
          `Edition quality rejected non-daily source ${primaryCandidate.source.sourceId} as item ${itemIndex + 1} primary evidence`,
        );
      }
      if (primaryClassification.releaseNote) releaseNoteCount += 1;
    }
    if (itemIndex === 0) {
      const leadFamilies = new Set(item.sourceIds.map((sourceId) => {
        const candidate = candidatesById.get(sourceId);
        return candidate ? signalSourcePolicy.familyFor(candidate) : "unknown";
      }));
      if (leadFamilies.size === 1 && leadFamilies.has("producthunt")) {
        throw new SignalValidationError("Edition quality rejected Product Hunt-only lead without independent supporting evidence");
      }
    }
    for (const sourceId of item.sourceIds) {
      const candidate = candidatesById.get(sourceId);
      if (!candidate) throw new SignalValidationError(`Edition quality found unknown candidate sourceId ${sourceId}`);
      const firstItem = firstItemBySourceId.get(sourceId);
      if (firstItem !== undefined && firstItem !== itemIndex) {
        throw new SignalValidationError(`Edition quality rejected candidate sourceId ${sourceId} in more than one item`);
      }
      firstItemBySourceId.set(sourceId, itemIndex);
      claimIdentity(normalizedUrl(candidate), "canonical URL", itemIndex, firstItemByUrl);
      claimIdentity(candidate.contentHash.trim().toLowerCase(), "content hash", itemIndex, firstItemByHash);
      claimIdentity(normalizedTitle(candidate.title), "normalized title", itemIndex, firstItemByTitle);
      const family = signalSourcePolicy.familyFor(candidate);
      const itemIndexes = familyItems.get(family) ?? new Set<number>();
      itemIndexes.add(itemIndex);
      familyItems.set(family, itemIndexes);
    }
  });

  for (const dossier of input.storyDossiers) {
    const itemIndexes = new Set<number>();
    const dossierCandidates = new Set(dossier.currentCandidateIds);
    input.draft.items.forEach((item, itemIndex) => {
      if (item.sourceIds.some((sourceId) => dossierCandidates.has(sourceId))) itemIndexes.add(itemIndex);
    });
    if (itemIndexes.size > 1) {
      throw new SignalValidationError(`Edition quality rejected dossier ${dossier.id} in more than one item`);
    }
  }

  const itemCount = input.draft.items.length;
  const releaseNoteLimit = signalSourcePolicy.releaseNoteLimit(itemCount);
  if (releaseNoteCount > releaseNoteLimit) {
    throw new SignalValidationError(
      `Edition quality rejected ${releaseNoteCount}/${itemCount} routine release-note items; maximum ${releaseNoteLimit}`,
    );
  }
  const familyCap = Math.floor(itemCount / 3);
  const hardFamilyCaps = editionFamilyCaps(input.candidates);
  const familyAssignment = matchStoryFamilies(
    storyComponents({ candidates: input.candidates, storyDossiers: input.storyDossiers }),
    itemCount,
    familyCap,
    signalSourcePolicy.releaseNoteLimit(itemCount),
    hardFamilyCaps,
  );
  for (const [family, itemIndexes] of familyItems) {
    const hardCap = hardFamilyCaps.get(family) ?? Number.POSITIVE_INFINITY;
    const effectiveCap = Math.min(familyAssignment ? familyCap : Number.POSITIVE_INFINITY, hardCap);
    if (itemIndexes.size > effectiveCap) {
      throw new SignalValidationError(
        `Edition quality rejected source family ${family} in ${itemIndexes.size}/${itemCount} items; maximum ${effectiveCap}${familyAssignment ? " when diverse candidates are available" : " by source policy"}`,
      );
    }
  }

  return input.draft;
}
