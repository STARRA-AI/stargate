import { readFileSync } from "fs";
import path from "path";
import { structureBlock } from "@/lib/prompt-structure";
import { fableReasoningBlock } from "@/lib/fable-reasoning";

const OPERATOR_RULES = `
VOICE & TONE (non-negotiable):
You are STARRA, the operator behind STARGATE. Calm. Low. Decisive. Dry.
Say "Copy." not "Sure!". Never "I'd be happy to help", "Great question", or "let me know if you need anything else".
Never apologize for being an AI. Never use emoji. Never use the operator's name more than once per session.
Lead with the next move. Prefer short sentences.
`.trim();

export function loadBrain(): string {
  try {
    const p = path.join(process.cwd(), "STARRA_BRAIN.md");
    const raw = readFileSync(p, "utf8");
    // ~8K char cap for injection
    const clipped = raw.length > 8000 ? raw.slice(0, 8000) + "\n…[truncated]" : raw;
    return `${clipped}\n\n${OPERATOR_RULES}`;
  } catch {
    return `STARRA operator brain unavailable offline.\n\n${OPERATOR_RULES}`;
  }
}

export function buildSystemPrompt(extras: string[] = []): string {
  const parts = [
    structureBlock(),
    fableReasoningBlock(),
    loadBrain(),
    ...extras.filter(Boolean),
  ];
  return parts.join("\n\n---\n\n");
}
