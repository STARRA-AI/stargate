import {
  ollamaAvailable,
  ollamaConfig,
  ollamaHasModel,
} from "@/lib/llm/ollama";

export const runtime = "nodejs";

export async function GET() {
  const { base, model } = ollamaConfig();
  const up = await ollamaAvailable();
  const hasModel = up ? await ollamaHasModel() : false;
  return Response.json({
    provider: process.env.LLM_PROVIDER || "auto",
    ollama: {
      base,
      model,
      up,
      hasModel,
      reasoning: "fable-inspired scaffold + local free model",
    },
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    priority:
      process.env.OLLAMA_PRIORITY === "1"
        ? "ollama-first"
        : "anthropic-if-keyed-else-ollama",
  });
}
