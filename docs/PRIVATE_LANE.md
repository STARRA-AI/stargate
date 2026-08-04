# Private lane — private-gpt beside the Kimi brain

An additive, local-only lane for asks and documents that must never leave
this Mac. Any deck or call turn that starts with `private` is routed to a
self-hosted [zylon-ai/private-gpt](https://github.com/zylon-ai/private-gpt)
service, backed exclusively by local Ollama (`qwen2.5:3b` for chat,
`nomic-embed-text` for embeddings) — never Kimi, Grok, FreeLLM, or Anthropic.
Normal chat and the live call are untouched; this sits beside them, gated by
one word.

## Bootstrap (once)

```sh
scripts/bootstrap-private-gpt.sh
```

Idempotent — clones `vendor/private-gpt` (gitignored, shallow), installs the
`private-gpt` CLI via `uv` (Python 3.11, prebuilt wheels), and pulls
`nomic-embed-text` in Ollama if missing. Safe to re-run; every step
short-circuits when already done. Full citations and landmines (macOS-12
`pypdfium2` wheel pin, the `pipefail`/`grep -q` fix) are in
`.superpowers/sdd/task-1-report.md` §2-3.

## Up / down

```sh
scripts/private-gpt-up.sh      # starts, binds 127.0.0.1:8080 only
scripts/private-gpt-down.sh    # stops by pid file
```

`private-gpt-up.sh` forces `--host 127.0.0.1` (the vendor's own default is
`0.0.0.0` with auth disabled — left as-is that would publish an
unauthenticated document/RAG API to the whole LAN the moment this Mac is on
Wi-Fi). It is not wired into `starra-up.sh` or the watchdog; it does not
autostart. `.env.local` carries:

```
PRIVATE_GPT_BASE=http://127.0.0.1:8080/v1
```

read by the route at request time — no restart needed beyond Next's own env
reload.

## The three commands

Typed into the deck chat, or into a live call:

- `private <ask>` — RAG chat against whatever has been ingested.
- `private ingest <path>` — reads a local file (absolute path, or `~/...`)
  and indexes it. Replies with `Ingested <name> — N documents indexed.`
  (see "N documents, not N chunks" below).
- `private docs` — lists what's currently indexed.

The prefix must be followed by whitespace or a colon — `privateer stories`,
`privately, I disagree`, and `private-gpt is running` do **not** match and
route normally. `private docs about taxes` is a chat ask, not a listing;
only a bare `private docs` (optionally with a colon) lists.

## Privacy guarantees

- **No external network call anywhere in the branch.** The private branch is
  an early `return` in `/api/chat`'s `POST` handler — structurally, not by a
  flag that can be edited around it — so every hosted call in the route
  (Kimi/Grok/FreeLLM/Anthropic, wttr.in weather, DuckDuckGo web search, the
  shell/tool fast-paths) sits lexically downstream of that return and is
  unreachable from inside it. The only host the branch ever talks to is
  `PRIVATE_GPT_BASE`, and a loopback check (`isLoopbackBase`) refuses to run
  at all if that value isn't `127.0.0.1`/`localhost`/`::1` — a typo'd or
  tampered env var cannot silently turn this into an exfiltration channel.
- **Replies are silent text, never spoken.** Both clients (deck chat and the
  live call) read the SSE stream's first frame, `data: {"private": true}`,
  before any text arrives, and skip TTS entirely for that turn — the deck
  never even loads `@/lib/voice/speak` (so `/api/tts`, which posts text to
  xAI for synthesis, is never called), and the call never reaches
  `speakForced` (so the reply is never handed to the xAI realtime socket).
  The reply still renders as text in both UIs.
- **Private turns never enter the shared memory store, later hosted
  prompts, or the call's context.** No `recordExchange`, no
  `extractFactsFromExchange`, for any private kind — on either client, on
  either surface. This matters beyond the obvious: `data/memory.json` is not
  a private place, it's an *input* — `memoryForPrompt` rides it into every
  hosted chat's system prompt, and `callDigest` rides it into the xAI
  realtime session's instructions. A private turn that got recorded there
  would leak on the *next* normal turn or the *next* call, not immediately.
  Both clients also strip any private-marked turns out of every outbound
  `/api/chat` body, so a private ask/reply pair never rides along inside a
  later normal request either.
- **Private CHAT turns are ephemeral by design — they are not remembered.**
  Nothing above is a durable private memory; it is a one-shot answer. His
  durable private memory is the private-gpt artifact store itself — what
  `private ingest` writes and `private docs` lists. There is no
  conversational memory *within* the private lane either: each `private …`
  ask is answered standalone, not against deck history, both for privacy
  (deck history can contain non-private turns) and because a 3B model's
  context window is small. A follow-up like `private and what about the
  other one?` will not resolve.
- **No hosted fallback, ever.** If private-gpt is unreachable, the branch
  streams one line — `Private lane is down. Run: scripts/private-gpt-up.sh`
  — and stops. It never falls back to a cloud provider; a silent fallback on
  a private failure would be exactly the leak this lane exists to prevent.

## Honest limits

- **A spoken private ask on a live call has already been heard by xAI's
  transcription.** That's inherent to being on an xAI-powered call, not a
  bug in this lane — xAI hears everything you say to start any turn, private
  or not, in order to transcribe it. The gate stops the *reply* and every
  stored copy of the exchange, but it cannot un-hear a sentence xAI's ears
  already transcribed. **Type `private …` on a call instead of speaking it**
  if the ask itself must never reach xAI.
- **If `STARRA_CALL_BRAIN=grok` is ever set** (the emergency rollback for the
  locked Kimi call brain — see `CLAUDE.md`), typed private asks on a call are
  **not** protected. That rollback path runs through xAI's own `grok`
  reasoning on the realtime socket, ungated by this lane by design — there is
  no local turn to intercept because xAI generates the reply itself. Do not
  rely on the private lane while that rollback is active.
- **RAG is forced, not optional, on every `private <ask>`.** `qwen2.5:3b`
  will not reliably self-select the `semantic_search` tool on its own (it
  asks a clarifying question instead), so the route always sends
  `tool_choice: {"type":"tool","name":"semantic_search"}` alongside a
  matching `tools` entry (the vendor server rejects `tool_context` without
  one). This is load-bearing, not an optimization — removing it silently
  turns every private chat into an un-grounded guess. See
  `src/app/api/chat/route.ts`, `streamPrivateChat`.
- **Ingest replies report documents indexed, not chunks.** The vendor's
  ingest response (`IngestResponse.data`) carries one entry per *document*,
  with no chunk/node count anywhere in the payload — a doc that indexes as 5
  vector nodes still returns exactly 1 entry. Hence `N documents indexed`,
  not `N chunks`. A re-ingest of an already-indexed file returns 0 entries
  (the vendor's de-dupe path, not a failure) and is reported as `already in
  the private index — nothing new to add.`
- **Local replies can take minutes.** Verified completions on this machine
  ran 291-680 seconds under CPU contention — an orphaned `llama-server`
  process (pid noted in `.superpowers/sdd/task-1-report.md`) was pinning a
  full core throughout testing, unrelated to this build and left untouched.
  The route allows up to 900 seconds per request
  (`PGPT_CHAT_CALLBACK_TIMEOUT_SECONDS=900`, set in `private-gpt-up.sh`) and
  streams `ping` frames the whole time so the connection doesn't go idle and
  die. Expect a genuine wait, not a hang.

## Vendor citations

Every env var, endpoint, and request-shape claim above was verified against
the cloned vendor source, not its README — full file:line citations live in
`.superpowers/sdd/task-1-report.md` (install command, port, env vars, API
routes, the Qdrant local-path fix) and `.superpowers/sdd/task-2-report.md`
(streaming wire format, request/response shapes, the forced tool-choice
requirement).

## Troubleshooting

- `private <ask>` replies "Private lane is down" → `scripts/private-gpt-up.sh`,
  then check `data/logs/private-gpt.log`.
- `scripts/private-gpt-up.sh` says the CLI isn't found →
  `scripts/bootstrap-private-gpt.sh` first.
- A reply is much slower than expected → check for other CPU-heavy local
  processes (`ps aux | grep -i llama`); this is a shared 8GB machine, not a
  private-gpt regression.
