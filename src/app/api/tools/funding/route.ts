import { getKey } from "@/lib/keys";
import { getFundingRegistry, summarizeFundingRegistry } from "@/lib/funding/registry";

export const runtime = "nodejs";

const FUTURE_HOOKS = [
  {
    id: "github_token" as const,
    label: "GitHub token",
  },
  {
    id: "open_collective_api_key" as const,
    label: "Open Collective API key",
  },
  {
    id: "aiassist_api_key" as const,
    label: "AiAssist API key",
  },
];

export async function GET() {
  const registry = getFundingRegistry();
  const summary = summarizeFundingRegistry(registry);

  const keyHooks = await Promise.all(
    FUTURE_HOOKS.map(async (slot) => ({
      id: slot.id,
      label: slot.label,
      linked: Boolean(await getKey(slot.id)),
    })),
  );

  return Response.json({
    registry,
    summary,
    keyHooks,
    stance:
      "Funding intel is normalized from public registries and curated lists. No live capital claims.",
  });
}
