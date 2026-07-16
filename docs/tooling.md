# STARGATE tooling integrations

Three external systems wired into the PWA.

## 1. Repomix — `yamadashy/repomix`

Packs the STARGATE codebase into an AI-friendly XML file.

| Surface | How |
|---------|-----|
| CLI | `npm run pack` |
| API | `POST /api/tools/repomix` |
| UI | Bridge → **Tools** → Pack repo |
| Console | say `pack the repo` |

Output: `data/packs/stargate-repomix.xml` (gitignored). Config: `repomix.config.json`.

## 2. OpenMontage — `calesthio/OpenMontage`

Agentic video production for Silent Shadow / Book of Starra.

| Surface | How |
|---------|-----|
| Vendor | `vendor/OpenMontage` (gitignored clone) |
| Bootstrap | `npm run tools:bootstrap` |
| API | `GET/POST /api/tools/openmontage` |
| UI | Tools → Queue Silent Shadow short |
| Console | say `queue a short about …` or `openmontage` |

Jobs land in `data/openmontage-jobs.json` and `data/openmontage-briefs/<id>.md`.

**Render is not automatic.** Open `vendor/OpenMontage/AGENT_GUIDE.md` in Cursor and run the queued brief. Optional heavy setup:

```bash
cd vendor/OpenMontage
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cd remotion-composer && npm install
```

## 3. system_prompts_leaks — `asgeirtj/system_prompts_leaks`

Reference library of extracted system prompts.

| Surface | How |
|---------|-----|
| Clone | `docs/reference/system_prompts_leaks` (gitignored) |
| Distill | `npm run tools:distill` or Tools → Re-distill |
| Runtime | `src/lib/prompt-structure.ts` injected ahead of `STARRA_BRAIN.md` |

**Policy:** steal section *structure* only. Never import Anthropic/OpenAI “warm assistant” tone. STARRA stays operator voice.

## 4. Local free brain — Fable reasoning + Ollama

| Piece | Detail |
|-------|--------|
| Reasoning scaffold | `src/lib/fable-reasoning.ts` (epistemology / verify-then-assert from Fable-5 patterns — **not** Claude impersonation) |
| STARRA canon | `STARRA_BRAIN.md` via `buildSystemPrompt()` |
| Free model | **`qwen2.5:1.5b`** default (instruction-tuned, Anthropic-API compatible, fits 8GB). Optional: `deepseek-r1:1.5b` for heavier chain-of-thought |
| Wire | `src/lib/llm/ollama.ts` → `/api/chat` (native `/api/chat`, then Anthropic/OpenAI compat) |
| Status | `GET /api/llm/status` · Settings deck readout |

```bash
ollama serve
ollama pull qwen2.5:1.5b
# optional reasoning specialist:
# ollama pull deepseek-r1:1.5b && echo 'OLLAMA_MODEL=deepseek-r1:1.5b' >> .env.local
npm run dev
```

Provider order with `OLLAMA_PRIORITY=1`: Ollama first when model is present; Anthropic only if you force `LLM_PROVIDER=anthropic`.
