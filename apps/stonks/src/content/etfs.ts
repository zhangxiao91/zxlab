import { buildInitialDailyCandles } from "../game/charting";
import type { EquityStockId, EtfId, SectorId, Stock, StockId } from "../game/types";

type EtfTemplate = {
  id: EtfId;
  name: string;
  sector: SectorId;
  price: number;
  components: Array<{
    stockId: EquityStockId;
    weight: number;
  }>;
  baseLiquidity: number;
  expenseRatioBps: number;
  trackingError: number;
};

export const etfTemplates: Record<EtfId, EtfTemplate> = {
  ETF_BROAD_MARKET: {
    id: "ETF_BROAD_MARKET",
    name: "Broad Market ETF",
    sector: "finance",
    price: 100,
    baseLiquidity: 260_000_000,
    expenseRatioBps: 18,
    trackingError: 0.0025,
    components: []
  },
  ETF_TECH_GROWTH: {
    id: "ETF_TECH_GROWTH",
    name: "Tech Growth ETF",
    sector: "tech",
    price: 50,
    baseLiquidity: 150_000_000,
    expenseRatioBps: 35,
    trackingError: 0.004,
    components: [
      { stockId: "DRAGON_SOFT", weight: 0.34 },
      { stockId: "CLOUDHARBOR_AI", weight: 0.32 },
      { stockId: "NORTHSTAR_ROBOTICS", weight: 0.22 },
      { stockId: "SILVER_PINES_SOLAR", weight: 0.12 }
    ]
  },
  ETF_BIOTECH_INNOVATION: {
    id: "ETF_BIOTECH_INNOVATION",
    name: "Biotech Innovation ETF",
    sector: "biotech",
    price: 40,
    baseLiquidity: 105_000_000,
    expenseRatioBps: 42,
    trackingError: 0.006,
    components: [
      { stockId: "NEW_HORIZON_BIO", weight: 0.5 },
      { stockId: "MIRROR_LAKE_MED", weight: 0.34 },
      { stockId: "ORCHID_SNACKS", weight: 0.16 }
    ]
  },
  ETF_PROPERTY_VALUE: {
    id: "ETF_PROPERTY_VALUE",
    name: "Property Value ETF",
    sector: "property",
    price: 30,
    baseLiquidity: 120_000_000,
    expenseRatioBps: 28,
    trackingError: 0.0045,
    components: [
      { stockId: "GOLDEN_ROOF", weight: 0.42 },
      { stockId: "RIVERSTONE_CEMENT", weight: 0.24 },
      { stockId: "HARBOR_BANK", weight: 0.2 },
      { stockId: "WESTERN_CLOUD_BANK", weight: 0.14 }
    ]
  },
  ETF_DEFENSE_SECURITY: {
    id: "ETF_DEFENSE_SECURITY",
    name: "Defense Security ETF",
    sector: "defense",
    price: 60,
    baseLiquidity: 130_000_000,
    expenseRatioBps: 32,
    trackingError: 0.0038,
    components: [
      { stockId: "SKY_SHIELD", weight: 0.52 },
      { stockId: "NORTHSTAR_ROBOTICS", weight: 0.22 },
      { stockId: "EAST_GRID_ENERGY", weight: 0.14 },
      { stockId: "COPPER_CROWN_MINING", weight: 0.12 }
    ]
  }
};

export function createEtfs(stocks: Record<StockId, Stock>): Record<EtfId, Stock> {
  return Object.fromEntries(
    Object.values(etfTemplates).map((template) => {
      const templateComponents = template.id === "ETF_BROAD_MARKET" ? createMarketCapWeightedComponents(stocks) : template.components;
      const components = templateComponents.map((component) => ({
        ...component,
        basePrice: stocks[component.stockId].price
      }));
      const weighted = getWeightedComponentStats(stocks, template.components);
      const stock: Stock = {
        id: template.id,
        name: template.name,
        assetType: "etf",
        sector: template.sector,
        boardType: "main",
        price: template.price,
        microPrice: template.price,
        microstructure: {
          flowMemory: 0,
          liquidityStress: 0,
          shockMemory: 0,
          lastPrintSign: 0
        },
        previousClose: template.price,
        open: template.price,
        high: template.price,
        low: template.price,
        marketCap: weighted.marketCap * 0.08,
        sharesOutstanding: Math.max(1, Math.floor((weighted.marketCap * 0.08) / template.price)),
        floatShares: Math.max(1, Math.floor((weighted.marketCap * 0.055) / template.price)),
        baseLiquidity: template.baseLiquidity,
        currentLiquidity: template.baseLiquidity,
        turnover: 0,
        volume: 0,
        pe: weighted.pe,
        fairPe: weighted.fairPe,
        earningsPerShare: Math.max(0.01, template.price / Math.max(1, weighted.pe)),
        netProfit: weighted.netProfit * 0.08,
        profitGrowth: weighted.profitGrowth,
        financialHealth: weighted.financialHealth,
        sentiment: weighted.sentiment,
        attention: weighted.attention,
        momentum: 0,
        heat: Math.max(6, weighted.heat * 0.45),
        buyQueue: 0,
        sellQueue: 0,
        boardStrength: 0,
        boardState: "loose",
        retail: {
          momentum: 44,
          dipBuyers: 48,
          newsFollowers: 38,
          gamblers: 24,
          bagholders: 22,
          panicSellers: 18,
          greed: 46,
          fear: 32,
          attention: weighted.attention * 0.75,
          boardFaith: 28
        },
        shrimpCohorts: [],
        quantPresence: 48,
        institutionPresence: 72,
        avgHolderCost: template.price,
        costDistribution: {
          deepProfit: 5,
          profit: 18,
          nearCost: 54,
          loss: 18,
          deepLoss: 5
        },
        activeModifiers: [],
        etf: {
          components,
          basePrice: template.price,
          nav: template.price,
          premiumDiscount: 0,
          expenseRatioBps: template.expenseRatioBps,
          trackingError: template.trackingError
        },
        auction: {
          phase: "preOpen",
          bias: {
            randomGap: 0,
            closeMovePct: 0,
            overrunFatigue: 0,
            richFatigue: 0,
            boardCarry: 0,
            repeatedLimitRelief: 0,
            washoutAttention: 0,
            openingDemandBias: 0
          },
          orders: [],
          referencePrice: template.price,
          referenceMatchedShares: 0,
          referenceMatchedNotional: 0,
          buyRemainingShares: 0,
          sellRemainingShares: 0,
          imbalanceShares: 0,
          settled: false
        },
        chart: [
          {
            day: 1,
            tick: 0,
            price: template.price,
            boardState: "loose"
          }
        ],
        dailyCandles: [],
        halted: false
      };

      stock.dailyCandles = buildInitialDailyCandles(stock);
      return [template.id, stock];
    })
  ) as Record<EtfId, Stock>;
}

function createMarketCapWeightedComponents(stocks: Record<StockId, Stock>): EtfTemplate["components"] {
  const equities = Object.values(stocks).filter((stock): stock is Stock & { id: EquityStockId } => stock.assetType === "stock");
  const totalMarketCap = equities.reduce((total, stock) => total + stock.marketCap, 0);

  return equities.map((stock) => ({
    stockId: stock.id,
    weight: stock.marketCap / Math.max(1, totalMarketCap)
  }));
}

function getWeightedComponentStats(stocks: Record<StockId, Stock>, components: EtfTemplate["components"]) {
  return components.reduce(
    (total, component) => {
      const stock = stocks[component.stockId];
      const weight = component.weight;
      return {
        marketCap: total.marketCap + stock.marketCap * weight,
        pe: total.pe + stock.pe * weight,
        fairPe: total.fairPe + stock.fairPe * weight,
        netProfit: total.netProfit + stock.netProfit * weight,
        profitGrowth: total.profitGrowth + stock.profitGrowth * weight,
        financialHealth: total.financialHealth + stock.financialHealth * weight,
        sentiment: total.sentiment + stock.sentiment * weight,
        attention: total.attention + stock.attention * weight,
        heat: total.heat + stock.heat * weight
      };
    },
    {
      marketCap: 0,
      pe: 0,
      fairPe: 0,
      netProfit: 0,
      profitGrowth: 0,
      financialHealth: 0,
      sentiment: 0,
      attention: 0,
      heat: 0
    }
  );
}
