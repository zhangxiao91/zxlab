import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTuningConfig, type PartialTuningConfig, type TuningConfig } from "../game/tuning";

export function loadTuningConfigFromFile(path: string): TuningConfig {
  const resolvedPath = resolve(path);
  const parsed = JSON.parse(readFileSync(resolvedPath, "utf8")) as PartialTuningConfig;
  return setTuningConfig(parsed);
}

export function loadTuningConfigFromArgs(args: string[]): { config?: TuningConfig; path?: string; rest: string[] } {
  const rest: string[] = [];
  let config: TuningConfig | undefined;
  let path: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config" || arg === "-c") {
      path = args[index + 1];
      index += 1;
      if (!path) throw new Error("Missing path after --config.");
      config = loadTuningConfigFromFile(path);
      continue;
    }
    rest.push(arg);
  }

  return { config, path, rest };
}
