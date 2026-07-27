export async function refreshStaticBriefing(env: Env): Promise<"triggered" | "not-configured"> {
  if (!env.PAGES_DEPLOY_HOOK_URL) return "not-configured";
  const response = await fetch(env.PAGES_DEPLOY_HOOK_URL, { method: "POST" });
  if (!response.ok) throw new Error(`Pages deploy hook returned ${response.status}`);
  return "triggered";
}
