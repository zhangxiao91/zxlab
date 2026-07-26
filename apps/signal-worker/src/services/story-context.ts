import type { CandidateSignal } from "@zxlab/signal-schema";

export interface PriorBriefingContext {
  briefingDate: string;
  title: string;
  summary: string;
}

export interface HistoricalSignalContext {
  candidateId: string;
  title: string;
  summary?: string;
  sourceName: string;
  publishedAt?: string;
}

export interface StoryDossier {
  id: string;
  anchorCandidateId: string;
  currentCandidateIds: string[];
  historicalSignals: HistoricalSignalContext[];
  priorCoverage: PriorBriefingContext[];
}

const LATIN_STOP_WORDS = new Set([
  "about", "after", "announces", "announcement", "from", "into", "latest", "launch", "launches",
  "news", "release", "releases", "report", "reports", "support", "supports", "update", "updates", "with",
]);
const HAN_STOP_BIGRAMS = new Set(["人工", "智能", "发布", "更新", "新增", "支持", "宣布", "报告", "最新", "功能"]);

function stemLatin(value: string): string {
  if (value.length > 5 && value.endsWith("ing")) return value.slice(0, -3);
  if (value.length > 4 && value.endsWith("ed")) return value.slice(0, -2);
  if (value.length > 4 && value.endsWith("es")) return value.slice(0, -2);
  if (value.length > 3 && value.endsWith("s")) return value.slice(0, -1);
  return value;
}

export function storyTerms(title: string): Set<string> {
  const normalized = title.normalize("NFKC").toLowerCase();
  const terms = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9]+(?:-[a-z0-9]+)*/g)) {
    const raw = match[0];
    if (raw.length < 3 || /^v?\d+(?:\.\d+)*$/.test(raw)) continue;
    const term = stemLatin(raw);
    if (!LATIN_STOP_WORDS.has(raw) && !LATIN_STOP_WORDS.has(term)) terms.add(term);
  }
  for (const match of normalized.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const chunk = match[0];
    for (let index = 0; index < chunk.length - 1; index += 1) {
      const bigram = chunk.slice(index, index + 2);
      if (!HAN_STOP_BIGRAMS.has(bigram)) terms.add(bigram);
    }
  }
  return terms;
}

export function storySimilarity(leftTitle: string, rightTitle: string): number {
  const left = storyTerms(leftTitle);
  const right = storyTerms(rightTitle);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const term of left) if (right.has(term)) intersection += 1;
  if (intersection < 2) return 0;
  const containment = intersection / Math.min(left.size, right.size);
  const jaccard = intersection / (left.size + right.size - intersection);
  return Math.max(containment * 0.75 + jaccard * 0.25, jaccard);
}

function related(left: CandidateSignal, right: CandidateSignal): boolean {
  return left.categoryHint === right.categoryHint && storySimilarity(left.title, right.title) >= 0.42;
}

function eventId(candidateIds: string[]): string {
  let hash = 0x811c9dc5;
  for (const character of candidateIds.slice().sort().join("|")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `story_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function timeOf(value: { publishedAt?: string; briefingDate?: string }): number {
  return Date.parse(value.publishedAt ?? value.briefingDate ?? "") || 0;
}

export function buildStoryDossiers(
  currentCandidates: CandidateSignal[],
  historicalCandidates: CandidateSignal[] = [],
  priorCoverage: PriorBriefingContext[] = [],
): StoryDossier[] {
  const parents = currentCandidates.map((_, index) => index);
  const find = (index: number): number => parents[index] === index ? index : (parents[index] = find(parents[index]!));
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  for (let left = 0; left < currentCandidates.length; left += 1) {
    for (let right = left + 1; right < currentCandidates.length; right += 1) {
      if (related(currentCandidates[left]!, currentCandidates[right]!)) union(left, right);
    }
  }

  const groups = new Map<number, CandidateSignal[]>();
  currentCandidates.forEach((candidate, index) => {
    const root = find(index);
    const group = groups.get(root) ?? [];
    group.push(candidate);
    groups.set(root, group);
  });

  return [...groups.values()].map((group) => {
    const historicalSignals = historicalCandidates
      .map((candidate) => ({ candidate, score: Math.max(...group.map((current) => storySimilarity(current.title, candidate.title))) }))
      .filter(({ candidate, score }) => candidate.categoryHint === group[0]!.categoryHint && score >= 0.42)
      .sort((left, right) => right.score - left.score || timeOf(right.candidate) - timeOf(left.candidate))
      .slice(0, 3)
      .map(({ candidate }) => ({
        candidateId: candidate.id,
        title: candidate.title,
        summary: candidate.summary?.slice(0, 320),
        sourceName: candidate.source.sourceName,
        publishedAt: candidate.publishedAt,
      }));
    const matchedCoverage = priorCoverage
      .map((coverage) => ({ coverage, score: Math.max(...group.map((current) => storySimilarity(current.title, coverage.title))) }))
      .filter(({ score }) => score >= 0.42)
      .sort((left, right) => right.score - left.score || timeOf(right.coverage) - timeOf(left.coverage))
      .slice(0, 2)
      .map(({ coverage }) => ({ ...coverage, summary: coverage.summary.slice(0, 320) }));
    const currentCandidateIds = group.map((candidate) => candidate.id);
    return {
      id: eventId(currentCandidateIds),
      anchorCandidateId: currentCandidateIds[0]!,
      currentCandidateIds,
      historicalSignals,
      priorCoverage: matchedCoverage,
    };
  });
}

export function selectStoryDossiers(dossiers: StoryDossier[], allowedCandidateIds: ReadonlySet<string>): StoryDossier[] {
  return dossiers.flatMap((dossier) => {
    const currentCandidateIds = dossier.currentCandidateIds.filter((id) => allowedCandidateIds.has(id));
    if (!currentCandidateIds.length) return [];
    return [{ ...dossier, anchorCandidateId: currentCandidateIds[0]!, currentCandidateIds }];
  });
}
