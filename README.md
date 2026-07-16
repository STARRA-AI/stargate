# STARGATE

Personal ops command deck for STARRA LLC. JARVIS-style PWA — voice-first, dark-only, operator register.

Canon: `STARRA_STARGATE_UNIFIED.md`, `STARGATE_DESIGN_SPEC.md`, `STARRA_BRAIN.md`, `STARRA_SOUL.md`.

## Run

```bash
cd ~/Projects/stargate
cp .env.example .env.local   # optional: ANTHROPIC_API_KEY, OPENAI_API_KEY
npm install
npm run tools:bootstrap      # OpenMontage + system_prompts_leaks + distill
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Local free brain (Fable reasoning + Ollama)

```bash
ollama serve
ollama pull deepseek-r1:1.5b   # already pulled if you followed setup
npm run dev
```

STARGATE injects: Fable-inspired reasoning scaffold + `STARRA_SOUL.md` (spiritual OS) + `STARRA_BRAIN.md` into local Ollama (`qwen2.5:1.5b` by default; optional `deepseek-r1:1.5b`). Priority over Anthropic when `OLLAMA_PRIORITY=1`. See `docs/tooling.md` §4.

## Screens

Bridge · Brief · Pipeline · Memory · Vault · Connectors · Settings · **Tools**

## Tools (integrated)

See [`docs/tooling.md`](docs/tooling.md).

- **Repomix** — `npm run pack` or console: `pack the repo`
- **OpenMontage** — queue Silent Shadow briefs from Tools
- **Prompt structure** — distilled from system_prompts_leaks into `src/lib/prompt-structure.ts`

## Stack

Next.js 15 · TypeScript · Tailwind v4 · Anthropic SSE · OpenAI Realtime (optional) · local JSON store (Supabase-ready)
