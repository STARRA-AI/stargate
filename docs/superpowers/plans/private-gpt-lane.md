# PRIVATE LANE — private-gpt beside the Kimi brain

Classic's order (2026-08-04): "clone zylon-ai/private-gpt into our current
infrastructure in order to protect my privacy." Scope confirmed with him the
same day: **a private lane BESIDE the locked Kimi brain** — normal chat and
the call stay exactly as locked this morning (brain=Kimi/Groq, voice=xAI);
NEW: sensitive asks and his private documents get a lane that NEVER leaves
the Mac (private-gpt API layer + local Ollama for both LLM and embeddings).

Verified live 2026-08-04 before this plan was written:
- github.com/zylon-ai/private-gpt: NOT archived, pushed 2026-08-04, 57.4k
  stars. Current form: "Complete API layer for private AI applications on
  local models: RAG, skills, tools, MCP… works with any OpenAI-compatible
  inference server." It does NOT run models itself.
- Install path (from its README): `uv tool install --python 3.11
  --find-links https://wheels.privategpt.dev/packages/ "private-gpt[core]"`
  — prebuilt wheels; `uv` is present at ~/.local/bin/uv. (Homebrew tap
  exists but Monterey brew compiles from source — do NOT use brew here.)
- Serves an OpenAI-compatible API on localhost:8080 (+ built-in UI at /ui).
- Local machine: macOS 12, 8GB RAM (56% free), 28GB disk free, Ollama
  RUNNING at 127.0.0.1:11434 with qwen2.5:3b (1.9GB) and qwen2.5:1.5b.
  Ollama exposes OpenAI-compat /v1 endpoints.
- Deck: Next.js at ~/Desktop/STARGATE/stargate, branch `addendum/gaps`,
  dev server live on :3000 (hot-reloads). /api/chat streams SSE frames
  `data: {"text": ...}` and already has an OpenAI-compat streamer
  (`streamOpenAICompat`, src/lib/llm/ollama.ts) and provider routing
  (src/app/api/chat/route.ts:342 `prefer`).

## Global Constraints (binding on every task)

- **FREE ONLY. NOTHING PAID.** No paid API, tier, or tool may be added or
  suggested. Everything runs on what exists: Ollama, uv, the free wheels.
- **DO NOT TOUCH THE LOCKED LANES.** `LLM_PROVIDER=kimi` (chat brain) and
  the xAI voice/call paths (src/lib/voice/*, STARRA_CALL_BRAIN) are
  Classic's locked orders from this same day. No task may reroute, rename,
  or "improve" them. The private lane is ADDITIVE.
- **PRIVACY IS THE SPEC.** Inside the private lane, NO external network
  call of any kind: no Groq, no xAI, no wttr.in weather, no DuckDuckGo
  web-search, no TTS through /api/tts (that POSTs reply text to xAI).
  Private replies are silent text. Only 127.0.0.1 targets are allowed
  (Ollama :11434, private-gpt :8080).
- **VERIFY FROM THE VENDOR CLONE, CITE file:line.** Every claim about
  private-gpt's env vars, endpoints, and request params MUST be verified
  from vendor/private-gpt's own docs/source and cited in the task report
  (path + line). The README summary above is a lead, not an authority.
- **THE TREE IS DIRTY WITH UNRELATED WORK (30 files).** Commit ONLY the
  files your task created/modified, by explicit path (`git add <paths>`).
  Never `git add -A`/`-u`/`.`. Never commit files you did not touch.
- **macOS 12 WebKit client rule:** NO regex lookbehind in any client-side
  code (src/components/**, src/lib/** reached by the browser).
- **UI copy rules:** operator voice ("Copy." not "Sure!"), no emojis in UI
  copy, dark-only tokens (--void/--chrome/--purple/--magenta).
- **8GB RAM discipline:** the embedding model must be the small
  `nomic-embed-text` (~274MB) unless vendor docs prove it unsupported, in
  which case `mxbai-embed-large` (~670MB) — cite the doc that forced it.
- Tests are node:test via `npx tsx --test tests/<file>.test.ts` (repo
  idiom: pure functions exported from modules; source-pattern assertions
  for wiring invariants). tsc (`npx tsc --noEmit`) and
  `npx eslint <changed files>` must pass at the end of every task.
- Plan file and runbook live in docs/; never in the repo root.

## Task 1: Vendor clone, runtime install, service scripts, end-to-end proof

Deliver the running private-gpt service, fed by local Ollama only.

1. Clone the vendor reference: `git clone --depth 1
   https://github.com/zylon-ai/private-gpt.git vendor/private-gpt`.
   Check whether vendor/ is git-ignored (`git check-ignore vendor/multica`
   as precedent). If it is NOT ignored, add `vendor/private-gpt/` to
   .gitignore (the deck vendors are clones, never committed).
2. Create `scripts/bootstrap-private-gpt.sh` (pattern: the existing
   scripts/bootstrap-multica.sh): idempotent — clone if missing, then
   `uv tool install --python 3.11 --find-links
   https://wheels.privategpt.dev/packages/ "private-gpt[core]"`, then
   `ollama pull nomic-embed-text` (see RAM constraint). Every step must
   be skippable when already done.
3. From the CLONE's docs (cite file:line in your report), determine the
   exact env/config for: LLM base URL + model, embedding base URL +
   model, listen port. Point BOTH LLM and embeddings at Ollama's
   OpenAI-compat surface (http://127.0.0.1:11434/v1), LLM model
   `qwen2.5:3b`, embed model per constraint. Port: 8080 unless something
   already listens there — then 8180, recorded in the report and in the
   env file.
4. Create `scripts/private-gpt-up.sh` and `scripts/private-gpt-down.sh`
   (pattern: scripts/starra-up.sh): up = start detached with the config
   from step 3, log to data/logs/private-gpt.log, refuse to double-start
   (pid file under data/); down = stop by pid file. Do NOT wire it into
   starra-up.sh or the watchdog (Classic decides later if it autostarts).
5. PROVE it end-to-end and paste the outputs in the report:
   a. `curl :PORT/v1/models` lists a model.
   b. A chat completion answers via qwen2.5:3b.
   c. Ingest one test document (create
      data/private-docs/smoke-test.txt with a distinctive fact) through
      the ingestion API found in the clone's docs (cite the route).
   d. A RAG-enabled query returns the distinctive fact.
   Delete nothing after: the smoke doc stays as the ingest example.
6. Append to .env.local (keys section untouched):
   `PRIVATE_GPT_BASE=http://127.0.0.1:PORT/v1` plus a one-line comment.
   .env.local is git-ignored — state its final content in the report
   instead of committing it.

Commit: the two scripts, .gitignore if changed, and nothing else.

## Task 2: The private lane in /api/chat

Additive branch in src/app/api/chat/route.ts + a pure command module.

1. New pure module `src/lib/private/commands.ts` exporting
   `parsePrivateCommand(text)` → `null | { kind: "chat", text } |
   { kind: "ingest", path } | { kind: "docs" }`:
   - `private <ask>` / `private: <ask>` (case-insensitive prefix, must be
     followed by whitespace/colon — "privateer stories" is NOT private)
     → chat with the prefix stripped.
   - `private ingest <absolute-or-~path>` → ingest.
   - `private docs` → docs listing.
   No regex lookbehind (client may import this later).
2. In /api/chat POST, BEFORE the shell/tool fast-paths and BEFORE the
   weather/web-search block (route.ts ~line 286-311): if
   parsePrivateCommand(lastUser) matches, enter the PRIVATE BRANCH:
   - The branch reads `PRIVATE_GPT_BASE` (default
     http://127.0.0.1:8080/v1). It makes requests ONLY to that base.
   - kind chat: stream the reply from private-gpt's chat endpoint with
     its RAG/context option enabled (exact param name from
     vendor/private-gpt docs — cite file:line; classic API used
     `use_context: true`). System prompt: a COMPACT private-mode persona
     (reuse clipSystemForLocal or equivalent tiering — a 3b model, not
     the full canon). Stream out as the same SSE `{"text": ...}` frames.
   - kind ingest: read the local file server-side (fs), POST it to the
     ingestion endpoint, stream back a one-line confirmation ("Ingested
     <name> — N chunks." per the API response).
   - kind docs: list ingested docs via the API, stream back the names.
   - FIRST SSE frame of every private reply, before any text:
     `data: {"private": true}` — the client's silence gate (Task 3).
   - The weather/webSearch/DDG code MUST be unreachable in this branch
     (privacy constraint). addTokens/pushFeed run as usual, but the
     pushFeed EXEC line must show only `Operator: [private]` — never the
     private text.
   - PRIVATE TURNS WRITE NOTHING TO THE SHARED MEMORY STORE. (PLAN
     CORRECTION 2026-08-04 — the original text said recordExchange still
     runs; that was a privacy bug: the shared store feeds later HOSTED
     prompts — memoryForPrompt rides Kimi requests and the call digest
     rides xAI session instructions — so a recorded private turn leaks on
     the next normal turn. No recordExchange, no extractFactsFromExchange,
     for any private kind. His private memory is the private-gpt artifact
     store itself.)
   - If private-gpt is unreachable: stream one line — "Private lane is
     down. Run: scripts/private-gpt-up.sh" — and do NOT fall back to any
     hosted provider (a silent fallback would leak the private ask).
3. Env plumbing: PRIVATE_GPT_BASE read at request time (no restart
   needed beyond the env reload Next already does).

Commit: route.ts, the new module, and nothing else.

## Task 3: Client silence gates — private replies never reach xAI

TWO clients consume /api/chat and both must honor the `{"private": true}`
first frame (SCOPE EXTENSION 2026-08-04, from Task 2's review: the live
call's brain path also posts to /api/chat and would speak a private reply
through the xAI realtime socket).

PART A — src/lib/stargate-context.tsx sendMessage: parse the SSE frames it
already splits; when the first frame is `{"private": true}`, set a
per-turn flag:
- Skip the speakStarra call entirely for that turn (silent — the
  private reply must not be POSTed to /api/tts, which sends text to xAI).
- The reveal gate (G3 sync-replies) must still release — use the existing
  "silent" path so text is never held back.
- The reply commits to VISIBLE history as today, but both the private ask
  and the private reply are marked on their history entries (extend `Msg`
  with `private?: true`), and sendMessage EXCLUDES private-marked turns
  from every outbound `/api/chat` fetch body. (PLAN CORRECTION
  2026-08-04: without this, the next normal turn ships the private text
  to the hosted Kimi brain inside `messages`. The shared store never
  holds private turns — Task 2 correction — so boot-seed and
  resyncHistory are clean automatically; the client history filter is
  the remaining leg.)
- The status log line becomes `[ORACLE] private reply landed · local only`.
No UI redesign: no new components, no styling changes.

PART B — src/lib/voice/useVoiceCall.ts runKimiTurn: its SSE assembly loop
(~line 1093-1100) currently keys only on `json.text`. Detect the
`{"private": true}` first frame; when present, the finished reply must:
- NEVER go to speakForced / the realtime socket (xAI must not receive the
  reply text; the force_message path is the leak).
- Appear in the call chat column as a transcript row, BUT without
  recordCallTurn (shared store → hosted leak) and WITHOUT entering
  callTurnsRef (that array rides later /api/chat bodies to the hosted
  Kimi brain).
- The user's private ask (the turn that triggered it) must likewise skip
  recordCallTurn and callTurnsRef — mark it in the visible transcript
  only. (A SPOKEN private ask has already been heard by xAI's
  transcription — that is inherent to being on an xAI call and out of
  scope; the gate stops the REPLY and the stored copies.)
- She stays silent for that turn on the call; the text is in the column.

Commit: stargate-context.tsx and useVoiceCall.ts only.

## Task 4: Tests, runbook, stack doc

1. tests/private-lane.test.ts (node:test, repo idiom):
   - parsePrivateCommand: prefix forms, colon form, case-insensitivity,
     "privateer" non-match, ingest path extraction, docs, null cases.
   - Source-pattern invariants: the private branch in route.ts contains
     no reference to webSearch/getWeather/hostedChat inside its block
     (assert the branch body, not the whole file, e.g. by slicing between
     recognizable markers); sendMessage contains the private-flag TTS
     skip; the first-frame contract `{"private": true}` appears in
     route.ts.
2. docs/PRIVATE_LANE.md runbook: what it is (one paragraph), bootstrap,
   up/down, the three commands (`private …`, `private ingest <path>`,
   `private docs`), the privacy guarantees (no external calls, silent
   replies, local memory only), and the verified vendor citations from
   Task 1's report.
3. CLAUDE.md Stack section: ONE line added under the brain/voice lines:
   the private lane exists, is additive, and must never be routed through
   hosted providers.
4. Full suite `npx tsx --test tests/*.test.ts` green; tsc green; eslint
   green on changed files.

Commit: the test file, docs/PRIVATE_LANE.md, CLAUDE.md.
