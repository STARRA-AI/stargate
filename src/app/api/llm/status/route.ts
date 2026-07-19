import { brainStatus, soulStatus } from "@/lib/brain";
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
    groq: Boolean(process.env.GROQ_API_KEY),
    grok: Boolean(process.env.XAI_API_KEY),
    groqModel: process.env.GROQ_MODEL || "moonshotai/kimi-k2-instruct-0905",
    grokModel: process.env.XAI_MODEL || "grok-4.5",
    soul: soulStatus(),
    brain: brainStatus(),
  });
}
