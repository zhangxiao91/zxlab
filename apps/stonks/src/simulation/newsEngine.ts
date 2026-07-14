import { newsTemplates } from "../content/newsTemplates";
import { createRng } from "../game/rng";
import type { GameState, NewsItem, Stock, StockId } from "../game/types";
import { getTuningConfig } from "../game/tuning";

export type NewsPressure = {
  impact: number;
  buyPressure: number;
  sellPressure: number;
};

const PRE_MARKET_NEWS_TICK = 0;
const MIDDAY_NEWS_TICK = 120;

export function sampleScheduledNews(game: GameState): NewsItem[] {
  if (hasGeneratedNewsAtCurrentTick(game)) return [];

  const rng = createRng(`${game.rngSeed}:scheduled-news:${game.day}:${game.tick}`);
  const activeCount = game.news.length;
  const count =
    game.tick === PRE_MARKET_NEWS_TICK
      ? choosePreMarketNewsCount(activeCount, rng.float(0, 1))
      : game.tick === MIDDAY_NEWS_TICK && rng.chance(getMiddayNewsProbability(activeCount))
        ? 1
        : 0;

  if (count <= 0) return [];

  const selected = chooseNewsTemplates(game, count, rng);
  const generated = selected.map((template) => instantiateNewsTemplate(template, game.day, game.tick));
  game.news.push(...generated);

  for (const item of generated) {
    game.eventLog.push({
      day: game.day,
      tick: game.tick,
      type: "newsGenerated",
      stockId: item.scope === "stock" && isStockId(game, item.targetId) ? item.targetId : undefined,
      message: `${item.title} (${item.source}, ${describeNewsTarget(item)}).`
    });
  }

  return generated;
}

export function choosePreMarketNewsCount(activeNewsCount: number, roll: number): number {
  const regression = Math.min(1, Math.max(0, (activeNewsCount - 2) / 6));
  const oneWeight = 0.28 + regression * 0.52;
  const twoWeight = 0.44 - regression * 0.24;

  if (roll < oneWeight) return 1;
  if (roll < oneWeight + twoWeight) return 2;
  return 3;
}

export function getMiddayNewsProbability(activeNewsCount: number): number {
  return Math.min(0.48, Math.max(0.06, 0.42 - Math.max(0, activeNewsCount - 3) * 0.075));
}

export function calculateNewsPressure(game: GameState, stock: Stock): NewsPressure {
  const tuning = getTuningConfig();
  const impact = game.news
    .filter((news) => news.scope === "market" || news.targetId === stock.sector || news.targetId === stock.id)
    .reduce((total, news) => total + news.polarity * news.strength * (news.credibility / 100), 0) *
    tuning.pressure.newsImpactMultiplier;

  return {
    impact,
    buyPressure: Math.max(0, impact) * 28_000,
    sellPressure: Math.max(0, -impact) * 28_000
  };
}

function chooseNewsTemplates(game: GameState, count: number, rng: ReturnType<typeof createRng>): NewsItem[] {
  const activeTemplateIds = new Set(game.news.map((item) => getTemplateIdFromInstance(item.id)));
  const pool = newsTemplates.filter((template) => !activeTemplateIds.has(template.id));
  const selected: NewsItem[] = [];
  const candidates = [...pool];

  while (selected.length < count && candidates.length > 0) {
    const totalWeight = candidates.reduce((total, template) => total + getTemplateWeight(game, template), 0);
    let needle = rng.float(0, totalWeight);
    let selectedIndex = 0;

    for (let index = 0; index < candidates.length; index += 1) {
      needle -= getTemplateWeight(game, candidates[index]);
      if (needle <= 0) {
        selectedIndex = index;
        break;
      }
    }

    const [template] = candidates.splice(selectedIndex, 1);
    selected.push(template);
  }

  return selected;
}

function getTemplateWeight(game: GameState, template: NewsItem): number {
  const relevantActiveNews = game.news.filter(
    (item) =>
      item.scope === template.scope &&
      (template.scope === "market" || item.targetId === template.targetId)
  ).length;
  const scopeWeight = template.scope === "stock" ? 1.18 : template.scope === "sector" ? 1 : 0.82;
  const freshnessWeight = Math.max(0.35, 1 - relevantActiveNews * 0.22);
  const credibilityWeight = 0.72 + template.credibility / 250;
  const heatWeight = 0.9 + template.heatImpact / 25;

  return scopeWeight * freshnessWeight * credibilityWeight * heatWeight;
}

function instantiateNewsTemplate(template: NewsItem, day: number, tick: number): NewsItem {
  return {
    ...structuredClone(template),
    id: `${template.id}_D${day}_T${tick}`,
    remainingDays: template.durationDays
  };
}

function getTemplateIdFromInstance(id: string): string {
  return id.replace(/_D\d+_T\d+$/, "");
}

function hasGeneratedNewsAtCurrentTick(game: GameState): boolean {
  return game.eventLog.some((event) => event.day === game.day && event.tick === game.tick && event.type === "newsGenerated");
}

function describeNewsTarget(item: NewsItem): string {
  if (item.scope === "market") return "market";
  return item.targetId ?? item.scope;
}

function isStockId(game: GameState, value: string | undefined): value is StockId {
  return value !== undefined && value in game.stocks;
}
