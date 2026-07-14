export type TuningConfig = {
  version: 1;
  market: {
    openingGapMultiplier: number;
    liquidityMultiplier: number;
    ambientTapeMultiplier: number;
    priceImpactMultiplier: number;
  };
  pressure: {
    playerMultiplier: number;
    playerFootprintMultiplier: number;
    retailMultiplier: number;
    collectiveMultiplier: number;
    whaleMultiplier: number;
    quantMultiplier: number;
    institutionMultiplier: number;
    fundamentalMultiplier: number;
    newsMultiplier: number;
    newsImpactMultiplier: number;
  };
  heat: {
    playerMultiplier: number;
    executionMultiplier: number;
    collectiveMultiplier: number;
    whaleMultiplier: number;
    quantMultiplier: number;
    newsMultiplier: number;
    boardMultiplier: number;
    priceMoveMultiplier: number;
  };
  whale: {
    orderSizeMultiplier: number;
    cooldownMultiplier: number;
  };
  notes?: string;
};

export type PartialTuningConfig = DeepPartial<TuningConfig>;

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export const DEFAULT_TUNING_CONFIG: TuningConfig = {
  version: 1,
  market: {
    openingGapMultiplier: 1,
    liquidityMultiplier: 1,
    ambientTapeMultiplier: 1,
    priceImpactMultiplier: 1
  },
  pressure: {
    playerMultiplier: 1,
    playerFootprintMultiplier: 1,
    retailMultiplier: 1,
    collectiveMultiplier: 1,
    whaleMultiplier: 1,
    quantMultiplier: 1,
    institutionMultiplier: 1,
    fundamentalMultiplier: 1,
    newsMultiplier: 1,
    newsImpactMultiplier: 1
  },
  heat: {
    playerMultiplier: 1,
    executionMultiplier: 1,
    collectiveMultiplier: 1,
    whaleMultiplier: 1,
    quantMultiplier: 1,
    newsMultiplier: 1,
    boardMultiplier: 1,
    priceMoveMultiplier: 1
  },
  whale: {
    orderSizeMultiplier: 1,
    cooldownMultiplier: 1
  },
  notes: "All multipliers default to 1. Values above 1 strengthen a system; values below 1 weaken it."
};

let activeTuningConfig: TuningConfig = cloneDefaultConfig();

export function getTuningConfig(): TuningConfig {
  return activeTuningConfig;
}

export function setTuningConfig(config: PartialTuningConfig): TuningConfig {
  activeTuningConfig = mergeTuningConfig(cloneDefaultConfig(), config);
  return activeTuningConfig;
}

export function resetTuningConfig(): TuningConfig {
  activeTuningConfig = cloneDefaultConfig();
  return activeTuningConfig;
}

export function mergeTuningConfig(base: TuningConfig, override: PartialTuningConfig): TuningConfig {
  const merged = structuredClone(base);
  mergeObject(merged as unknown as Record<string, unknown>, override as Record<string, unknown>);
  normalizeTuningConfig(merged);
  return merged;
}

function cloneDefaultConfig(): TuningConfig {
  return structuredClone(DEFAULT_TUNING_CONFIG);
}

function mergeObject(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeObject(target[key] as Record<string, unknown>, value as Record<string, unknown>);
      continue;
    }
    target[key] = value;
  }
}

function normalizeTuningConfig(config: TuningConfig): void {
  config.version = 1;
  clampRecord(config.market, 0, 5);
  clampRecord(config.pressure, 0, 5);
  clampRecord(config.heat, 0, 5);
  clampRecord(config.whale, 0.05, 5);
}

function clampRecord(record: Record<string, number>, min: number, max: number): void {
  for (const [key, value] of Object.entries(record)) {
    record[key] = Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : 1;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
