import { SignalValidationError } from "@zxlab/signal-schema";
import { BriefingRepository } from "../repositories/briefing-repository";
import { json } from "../lib/http";

export async function handleBriefingRead(pathname: string, env: Env): Promise<Response | null> {
  if (!pathname.startsWith("/api/briefings/")) return null;
  const repository = new BriefingRepository(env.DB);
  const key = decodeURIComponent(pathname.slice("/api/briefings/".length));
  if (!key || key.includes("/")) throw new SignalValidationError("Invalid briefing path");
  if (key === "latest") return json(await repository.getLatest());
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return json(await repository.getByDate(key));
  return json(await repository.getById(key));
}
