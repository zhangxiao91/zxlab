import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_TUNING_CONFIG, getTuningConfig, mergeTuningConfig, setTuningConfig, type PartialTuningConfig } from "../game/tuning";
import { loadTuningConfigFromFile } from "./tuningConfig";
import { createInitialGame } from "../game/createInitialGame";
import { updateTick } from "../simulation/tick";
import { GAME_CONFIG } from "../game/config";
import type { BoardState, StockId } from "../game/types";
import { moneyShort, pad } from "./format";

type ProbeSummary = {
  seed: string;
  ticks: number;
  minReturnPct: number;
  maxReturnPct: number;
  panicTicks: number;
  limitUpTicks: number;
  limitDownTicks: number;
  whaleTrades: number;
  whalePnl: number;
  worstStock: StockId;
  worstReturnPct: number;
};

const [command = "help", ...args] = process.argv.slice(2);

if (command === "init") {
  const outputPath = resolve(args[0] ?? "tuning.local.json");
  writeFileSync(outputPath, `${JSON.stringify(DEFAULT_TUNING_CONFIG, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
} else if (command === "list" || command === "schema") {
  console.log(JSON.stringify(DEFAULT_TUNING_CONFIG, null, 2));
} else if (command === "show") {
  const configPath = args[0];
  if (configPath) loadTuningConfigFromFile(configPath);
  console.log(JSON.stringify(getTuningConfig(), null, 2));
} else if (command === "probe") {
  runProbeCommand(args);
} else {
  printHelp();
}

function runProbeCommand(args: string[]): void {
  let configPath: string | undefined;
  let seedArg = "";
  let days = 10;
  const inlineOverrides: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config" || arg === "-c") {
      configPath = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--days" || arg === "-d") {
      days = Math.min(GAME_CONFIG.totalDays, Math.max(1, Number.parseInt(args[index + 1] ?? "10", 10)));
      index += 1;
      continue;
    }
    if (arg === "--set") {
      inlineOverrides.push(args[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (!seedArg) seedArg = arg;
  }

  if (configPath) loadTuningConfigFromFile(configPath);
  for (const override of inlineOverrides) applyInlineOverride(override);

  const seeds = seedArg ? seedArg.split(",").map((seed) => seed.trim()).filter(Boolean) : buildDefaultSeeds();
  const summaries = seeds.map((seed) => runProbe(seed, days));
  printProbeTable(summaries, days, configPath);
}

function applyInlineOverride(raw: string | undefined): void {
  if (!raw) throw new Error("Missing KEY=VALUE after --set.");
  const [path, rawValue] = raw.split("=");
  const value = Number(rawValue);
  if (!path || !Number.isFinite(value)) throw new Error(`Invalid --set override: ${raw}`);

  const patch: Record<string, unknown> = {};
  const parts = path.split(".");
  let cursor = patch;
  for (const part of parts.slice(0, -1)) {
    cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1) ?? path] = value;
  setTuningConfig(mergeTuningConfig(getTuningConfig(), patch as PartialTuningConfig));
}

function runProbe(seed: string, targetDays: number): ProbeSummary {
  const game = createInitialGame(seed);
  const initialPrices = Object.fromEntries(Object.values(game.stocks).map((stock) => [stock.id, stock.price])) as Record<StockId, number>;
  let ticks = 0;
  let panicTicks = 0;
  let limitUpTicks = 0;
  let limitDownTicks = 0;
  let whaleTrades = 0;

  while (game.phase !== "ended" && !(game.day >= targetDays + 1 && game.phase === "preMarket" && game.tick === 0)) {
    const result = updateTick(game);
    ticks += 1;
    whaleTrades += result.whaleTrades.length;
    const counts = countBoardStates(result.stocks.map((stock) => stock.boardState));
    panicTicks += counts.panic + counts.brokenBoard;
    limitUpTicks += counts.sealedLimitUp + counts.weakSeal + counts.attackingLimitUp;
    limitDownTicks += counts.limitDown;
  }

  const stockReturns = Object.values(game.stocks).map((stock) => ({
    stockId: stock.id,
    returnPct: (stock.price / initialPrices[stock.id] - 1) * 100
  }));
  const sortedReturns = [...stockReturns].sort((a, b) => a.returnPct - b.returnPct);
  const whalePnl = game.whales.reduce((total, whale) => total + whale.realizedPnl + whale.unrealizedPnl, 0);

  return {
    seed,
    ticks,
    minReturnPct: sortedReturns[0]?.returnPct ?? 0,
    maxReturnPct: sortedReturns.at(-1)?.returnPct ?? 0,
    panicTicks,
    limitUpTicks,
    limitDownTicks,
    whaleTrades,
    whalePnl,
    worstStock: sortedReturns[0]?.stockId ?? "DRAGON_SOFT",
    worstReturnPct: sortedReturns[0]?.returnPct ?? 0
  };
}

function countBoardStates(states: BoardState[]): Record<BoardState, number> {
  const counts: Record<BoardState, number> = {
    loose: 0,
    attackingLimitUp: 0,
    sealedLimitUp: 0,
    weakSeal: 0,
    brokenBoard: 0,
    panic: 0,
    limitDown: 0
  };
  for (const state of states) counts[state] += 1;
  return counts;
}

function printProbeTable(summaries: ProbeSummary[], days: number, configPath?: string): void {
  console.log("Tuning probe");
  console.log(`Config=${configPath ?? "defaults"} seeds=${summaries.length} targetDays=${days}`);
  console.log(
    [pad("Seed", 18), pad("Min%", 8), pad("Max%", 8), pad("Panic", 7), pad("UpBd", 7), pad("DnBd", 7), pad("WTrades", 8), pad("WPnL", 10), pad("Worst", 18)].join(" ")
  );
  for (const summary of summaries) {
    console.log(
      [
        pad(summary.seed, 18),
        pad(summary.minReturnPct.toFixed(1), 8),
        pad(summary.maxReturnPct.toFixed(1), 8),
        pad(summary.panicTicks.toString(), 7),
        pad(summary.limitUpTicks.toString(), 7),
        pad(summary.limitDownTicks.toString(), 7),
        pad(summary.whaleTrades.toString(), 8),
        pad(moneyShort(summary.whalePnl), 10),
        pad(`${summary.worstStock}:${summary.worstReturnPct.toFixed(1)}%`, 18)
      ].join(" ")
    );
  }

  console.log("");
  console.log(
    `Average: min=${average(summaries, "minReturnPct").toFixed(1)}% max=${average(summaries, "maxReturnPct").toFixed(1)}% ` +
      `panic=${average(summaries, "panicTicks").toFixed(1)} upBoard=${average(summaries, "limitUpTicks").toFixed(1)} ` +
      `downBoard=${average(summaries, "limitDownTicks").toFixed(1)} whaleTrades=${average(summaries, "whaleTrades").toFixed(1)}`
  );
}

function average(summaries: ProbeSummary[], key: keyof ProbeSummary): number {
  return summaries.reduce((total, summary) => total + Number(summary[key]), 0) / Math.max(1, summaries.length);
}

function buildDefaultSeeds(): string[] {
  return Array.from({ length: 8 }, (_, index) => `tune-${index + 1}`);
}

function printHelp(): void {
  console.log(`Usage:
  npm run tune -- init [path]                         Write a default JSON tuning file
  npm run tune -- list                                Print default tuning schema
  npm run tune -- show [path]                         Print merged defaults + JSON config
  npm run tune -- probe [seeds] [--days N] [-c path]  Run a compact balance probe
  npm run tune -- probe seed-a,seed-b --set pressure.collectiveMultiplier=0.8
`);
}
