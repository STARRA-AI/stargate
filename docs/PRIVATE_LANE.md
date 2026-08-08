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
scripts/private-gpt-up.sh      # brain — starts, binds 127.0.0.1:8080 only
scripts/private-gpt-down.sh    # stops by pid file
scripts/whisper-up.sh          # ears — 127.0.0.1:8178, only a PRIVATE CALL needs it
scripts/whisper-down.sh        # stops by pid file
```

`private-gpt-up.sh` forces `--host 127.0.0.1` (the vendor's own default is
`0.0.0.0` with auth disabled — left as-is, this would publish an
unauthenticated document/RAG API to the whole LAN the moment this Mac is on
Wi-Fi). It is not wired into `starra-up.sh` or the watchdog; it does not
autostart. `.env.local` carries:

```
PRIVATE_GPT_BASE=http://127.0.0.1:8080/v1
WHISPER_BASE=http://127.0.0.1:8178
```

both read by their routes at request time — no restart needed beyond Next's own
env reload. Both are **server-side only** (no `NEXT_PUBLIC_` twin): they name
the privacy boundary, so they never get baked into a client bundle. Each must
be a numeric loopback literal or its route refuses to start — see SECURITY
POSTURE.

**The port lives in two places — keep them equal.** The script binds
`PRIVATE_GPT_PORT` (default `8080`, `scripts/private-gpt-up.sh`), and the route
dials whatever port is inside `PRIVATE_GPT_BASE`. Change one without the other
and the deck is pointed at nothing: every `private …` turn answers
`Private lane is down.` while the service is in fact up on the other port.

## The three commands

Typed into the deck chat, or into a live call:

- `private <ask>` — RAG chat against whatever has been ingested.
- `private ingest <path>` — reads a local file (absolute path, or `~/...`)
  and indexes it. Replies with `Ingested <name> — N documents indexed.`
  (see "N documents, not N chunks" below). **Deck-local only**: it reads any
  absolute path on this Mac server-side, so — exactly like `run:`/`$` shell
  commands — a request that arrived over the LAN/phone is refused before the
  read, with `Private ingest is disabled over the network for safety.` Ask and
  `docs` stay usable from the phone; they expose answers, not new file reads.
- `private docs` — lists what's currently indexed.

The prefix must be followed by whitespace or a colon — `privateer stories`,
`privately, I disagree`, and `private-gpt is running` do **not** match and
route normally. `private docs about taxes` is a chat ask, not a listing;
only a bare `private docs` (optionally with a colon) lists.

## PRIVATE CALL — her ears, her brain and her voice, all on this Mac

The deck's call overlay has a two-button engine selector: **NORMAL** and
**PRIVATE**.

- **NORMAL is byte-identical to the call he has always had** — xAI realtime
  socket, Eve's voice, Kimi brain (`CLAUDE.md`, Stack). Nothing in this project
  changed it.
- **PRIVATE runs the whole loop locally**: mic → whisper.cpp on
  `127.0.0.1:8178` (ears) → the private lane above on `127.0.0.1:8080` (brain)
  → Piper in the tab, model files served from `/brand/voice` (mouth). No xAI
  socket is opened at all on a private call.

**How to use it**

1. `scripts/private-gpt-up.sh` and `scripts/whisper-up.sh` (both idempotent;
   neither autostarts).
2. `bash scripts/bootstrap-piper-assets.sh` once, if `public/brand/voice/` is
   empty — her local mouth is **opt-in by asset**, and with the files absent a
   private call refuses to open rather than opening mute.
3. Open the call, press **PRIVATE**, then dial. The engine is **captured at
   connect**: pressing the other button mid-call sets the *next* call's engine
   and the note under the selector says so.

**Every turn is a `private …` turn.** Whatever he says is prefixed before it
reaches `/api/chat`, so the local-only branch is the only branch a private call
can take. **His VOICE can only ever ASK**: a spoken line is handed to the real
`parsePrivateCommand`, and anything that would parse as a *subcommand* is
quoted first — so saying "ingest the quarterly report" asks about it, it does
not read a file off the disk (`src/lib/voice/usePrivateCall.ts`,
`privateAskBody`). Typed `private ingest <path>` on the deck still works and is
still deck-local only.

### Measured latency — TWO REGIMES, and the difference is retrieval

All numbers on this Mac (2-core Intel, 8 GB), warm, model resident.

| | brain, measured | when |
|---|---|---|
| **fast path** (no documents indexed) | **2.8 – 2.9 s** | empty collection |
| **RAG path** (documents indexed) | **19 – 30 s** | anything ingested |

Same ask, same service, same model, 2026-08-05, direct to
`127.0.0.1:8080/v1/messages`: no-tools 2.92 s / 2.77 s warm (14.4 s first
request); the forced-`semantic_search` body 30.18 s then 19.18 s. The
dev-server log names the cost exactly — `prompt eval time = 9994.13 ms /
169 tokens` against `eval time = 1034.83 ms / 7 tokens`: **~90 % of her think
time is evaluating a retrieval-stuffed prompt, not writing the answer.**

So the route only pays for retrieval when there is something to retrieve. It
probes the artifacts list (one loopback GET, **30 ms measured**, memoized for
60 s, so it is not per-turn overhead), and with an **empty** collection sends a
plain completion — no `tools`, no `tool_choice`, no `tool_context`. With
**anything ingested**, behaviour is exactly what it was. A `private ingest`
drops the memo immediately, so a fresh ingest is never ignored. If the probe
cannot answer (service down, non-200, unparseable body) it assumes documents
exist and runs RAG — the fast path is an optimisation, never a guess.

End-to-end per call turn, with the default `en_GB-cori-medium` voice:

```
  ears (whisper, deck route)     1.6 s
  brain — no documents           2.8 – 4.5 s      <- fast path
  brain — documents indexed      17 – 24 s        <- RAG, prompt-eval bound
  first sentence (Piper medium)  ~1.8 s           <- RTF 0.39, faster than speech
  ──────────────────────────────────────────
  TOTAL, empty collection       ~6 – 8 s
  TOTAL, with documents        ~20 – 27 s
```

The status line still says **"PRIVATE — local brain, slower"** whenever a turn
is over the 5 000 ms slow budget, and treats an unmeasured turn as slow.

### Her local voice: Cori, medium tier

`PIPER_VOICE_ID` (`src/lib/voice/piper-speak.ts`) is **`en_GB-cori-medium`**.
Same speaker as `high` — Book 1 §7's one consistent voice is intact — at a
faster tier, because `high` is not usable live on this machine: measured in the
real browser, `high` synthesises at **RTF 3.14 / 2.78** (three seconds of CPU
per second of speech) against `medium`'s **0.39 / 0.36**, with
`TtsSession.create` 7 783 ms → 3 753 ms and the OPFS seed 2 369 ms → 1 387 ms.
That is ~13 s off every spoken turn.

`high` is not gone. Fetch it and select it:

```sh
bash scripts/bootstrap-piper-assets.sh en_GB-cori-high
# then, in the deck's browser console (takes effect next page load):
#   localStorage.setItem("stargate.localVoice", "en_GB-cori-high")
# or permanently, in .env.local:
#   NEXT_PUBLIC_STARRA_LOCAL_VOICE=en_GB-cori-high
```

## SECURITY POSTURE — what is actually enforced

Each line verified against the source named, on 2026-08-05.

- **The deck is password-gated, and `/api/*` is inside the gate.**
  `src/middleware.ts` matches everything except static assets, returns a clean
  `401` for any unauthenticated `/api/` path (`middleware.ts:72-73`) and
  redirects pages to `/login`. It **fails CLOSED**: with no `STARRA_PASSWORD`
  configured, a non-local request is refused with `503 deck sealed`
  (`middleware.ts:53-60`) rather than waved through. `STARRA_PASSWORD` **is
  set** in `.env.local` on this machine (line 31, value not read here). Only
  `/login`, `/api/auth`, and `/starra-ca.crt` are public (`middleware.ts:8`).
  Every authed response also carries `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, and a
  `Permissions-Policy` with `camera=()`.
- **Both local services bind loopback only, overriding a vendor default that
  does not.** `scripts/private-gpt-up.sh:66-70` pins `HOST="127.0.0.1"` and
  serves with `--host "$HOST"` (line 90) — the vendor's own default is
  `0.0.0.0` **with auth disabled**, which on Wi-Fi would publish an
  unauthenticated document/RAG API to the whole LAN. `scripts/whisper-up.sh:26-27`
  hardcodes `127.0.0.1:8178` with **no env override at all** ("this is the
  privacy boundary, not a tunable"). Verified live with
  `lsof -nP -iTCP -sTCP:LISTEN`: `127.0.0.1:8080` (private-gpt),
  `127.0.0.1:8178` (whisper), `127.0.0.1:11434` (Ollama) — no `0.0.0.0`, no `*`.
- **The egress gate is numeric-only and shared by both consumers.**
  `isLoopbackBase` lives in `src/lib/private/loopback.ts` — ONE definition,
  imported by the chat route's private branch and by
  `/api/private-call/transcribe`. It accepts dotted `127.x` and `::1` and
  refuses everything else, **`localhost` included**, because a name is only
  what a resolver says it is and a prefix test on a name waves through
  `127.0.0.1.evil.example.com`. A base that fails it does not fall back — the
  lane refuses to start and says so. Pinned against a table of hostile inputs
  in `tests/private-lane.test.ts`.
- **`private ingest` is deck-local only.** It reads any absolute path on this
  Mac server-side, so a request that arrived over the LAN/phone is refused
  before the read, through the same shared `isLocalRequest` helper the shell
  primitive uses (`src/app/api/chat/route.ts`, the ingest arm). Ask and `docs`
  stay usable from the phone: they expose answers, not new file reads.
- **The transcribe route is bounded and typed before it costs anything.** It
  refuses a body under 46 bytes, over `30 s × 16 kHz × 2 B` (`MAX_WAV_BYTES`),
  or that does not start with `RIFF….WAVE` — the magic check runs before any
  work, because a `no-cors` cross-origin POST is a request the browser will
  still send even though it cannot read the reply. It makes exactly ONE
  outbound request, to the loopback-guarded base, with no fallback, and records
  nothing.
- **No CDN in her local mouth.** `@mintplex-labs/piper-tts-web` defaults its
  WASM to cdnjs/jsdelivr and its models to huggingface; `LOCAL_WASM_PATHS`
  (`src/lib/voice/local-voice.ts:396-398`) overrides both with same-origin
  paths under `/brand/voice`, and the normal-lane Piper session is created with
  the same local paths so the library's process-wide singleton can never be
  armed with CDN defaults for a private turn to inherit. Pinned by
  `tests/local-voice.test.ts`.
- **Speech cannot become a command.** On a private call the spoken line is run
  through the real `parsePrivateCommand`; anything that is not `kind:"chat"` is
  quoted, so no utterance can reach the filesystem-reading `ingest` arm
  (`src/lib/voice/usePrivateCall.ts`, `privateAskBody`).

**The limits this posture does NOT cover** — all documented in full under
*Honest limits* below: a private ask **spoken on a NORMAL call** was already
heard by xAI; a private ask **spoken at the deck** (wake word / open mic) was
already heard by Google's server-side recognizer; and with
`STARRA_CALL_BRAIN=grok` set, typed private asks on a call are not protected at
all. A **spoken ask on a PRIVATE call is safe** — those ears are whisper.cpp on
this machine.

## Privacy guarantees

- **No external network call anywhere in the branch.** The private branch is
  an early `return` in `/api/chat`'s `POST` handler — structurally, not by a
  flag that can be edited around it — so every hosted call in the route
  (Kimi/Grok/FreeLLM/Anthropic, wttr.in weather, DuckDuckGo web search, the
  shell/tool fast-paths) sits lexically downstream of that return and is
  unreachable from inside it. The only host the branch ever talks to is
  `PRIVATE_GPT_BASE`, and a loopback check (`isLoopbackBase`) refuses to run
  at all unless that value is a **numeric loopback literal** — dotted `127.x`
  or `::1`, nothing else — so a typo'd or tampered env var cannot silently
  turn this into an exfiltration channel. **Host NAMES are refused,
  `localhost` included**, on purpose: a name is only ever what a resolver says
  it is (`/etc/hosts`, a search domain, a hijacked resolver), and a prefix test
  on a name is worse still — `127.0.0.1.evil.example.com` and
  `127.attacker.example.com` are ordinary DNS-resolvable hosts that such a test
  would wave through. Use the literal IP, which is what the default,
  `.env.local`, and `private-gpt-up.sh` all use anyway.
- **Replies never reach a hosted voice. Both the deck and a PRIVATE call speak
  them with her LOCAL mouth; a private turn typed into a NORMAL call stays
  silent text.** Both clients read the SSE
  stream's first frame, `data: {"private": true}`, before any text arrives, and
  neither hands that turn to xAI: the deck never loads `@/lib/voice/speak` (so
  `/api/tts`, which posts text to xAI for synthesis, is never called), and the
  call never reaches `speakForced` (so the reply is never handed to the xAI
  realtime socket). What the deck DOES do now is speak it locally —
  `speakLocalStream` (`src/lib/voice/local-voice.ts`) synthesises Piper inside
  the tab, sentence by sentence, from model files the deck serves itself at
  `/brand/voice`, and makes no request off this machine (the library's CDN
  defaults for its WASM and its models are overridden there, and
  `tests/local-voice.test.ts` pins that). Local voice is OPT-IN BY ASSET: with
  those files absent — the state of a fresh checkout — she stays silent text
  exactly as before, never a fallback that phones out (a PRIVATE call refuses
  to open at all in that state, with the command that fixes it). Set
  `stargate.localVoice` in localStorage (or `NEXT_PUBLIC_STARRA_LOCAL_VOICE`)
  to pick a different Piper voice — the default is `en_GB-cori-medium`; it
  takes effect on the next page load. The reply always renders as text in both
  UIs.
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

- **A spoken ask on a PRIVATE call is SAFE — this limit is about the NORMAL
  call.** On a **private** call the ears are whisper.cpp on `127.0.0.1:8178`
  and the audio never leaves the Mac, so speaking is as private as typing.
  On a **NORMAL** call it is not: **a spoken private ask has already been heard
  by xAI's transcription.** That's inherent to being on an xAI-powered call,
  not a bug in this lane — xAI hears everything you say to start any turn,
  private or not, in order to transcribe it. The gate stops the *reply* and
  every stored copy of the exchange, but it cannot un-hear a sentence xAI's
  ears already transcribed. On a normal call, **type `private …` instead of
  speaking it** — or press PRIVATE and speak freely.
- **A private ask SPOKEN at the deck has already been heard by Google.** Not
  just on a call — the deck's own wake-word and open-mic paths run through
  Chrome's `SpeechRecognition` (`src/lib/voice/useVoiceLoop.ts`, `getSR()`),
  which is a *server-based* recognizer: the audio goes to Google and comes back
  as text, and only then does that text reach `sendMessage` and this lane. By
  the time the word `private` exists as a string, the sentence has already left
  the Mac. The lane still does its whole job on that text — local answer, no
  TTS, nothing stored — but it cannot un-send the audio. **Type `private …`
  into the deck instead of speaking it** when the ask itself must never leave
  the machine.
- **If `STARRA_CALL_BRAIN=grok` is ever set** (the emergency rollback for the
  locked Kimi call brain — see `CLAUDE.md`), typed private asks on a call are
  **not** protected. That rollback path runs through xAI's own `grok`
  reasoning on the realtime socket, ungated by this lane by design — there is
  no local turn to intercept because xAI generates the reply itself. Do not
  rely on the private lane while that rollback is active.
- **RAG is forced whenever it runs — but it only runs when documents exist.**
  `qwen2.5:3b` will not reliably self-select the `semantic_search` tool on its
  own (it asks a clarifying question instead), so when retrieval is on the
  route always sends `tool_choice: {"type":"tool","name":"semantic_search"}`
  alongside a matching `tools` entry (the vendor server rejects `tool_context`
  without one). That forcing is load-bearing, not an optimization — removing
  it would silently turn a grounded private chat into an un-grounded guess.
  What IS conditional is whether retrieval happens at all: against an **empty**
  collection the route sends a plain completion (all three tool keys absent
  together) and the system prompt drops the "answer from the retrieved
  documents" paragraph, because instructing a model to cite documents that do
  not exist invites exactly the invented citation the paragraph exists to
  prevent. See `src/app/api/chat/route.ts` — `privateDocsPresent`,
  `privateChatRequestBody`, `streamPrivateChat` — and the two-regime latency
  table above. Both regimes are pinned in `tests/private-lane.test.ts`.
- **Ingest replies report documents indexed, not chunks.** The vendor's
  ingest response (`IngestResponse.data`) carries one entry per *document*,
  with no chunk/node count anywhere in the payload — a doc that indexes as 5
  vector nodes still returns exactly 1 entry. Hence `N documents indexed`,
  not `N chunks`. A re-ingest of an already-indexed file returns 0 entries
  (the vendor's de-dupe path, not a failure) and is reported as `already in
  the private index — nothing new to add.`
- **The active model now stays resident — cold loads are the exception, not
  the norm.** `scripts/starra`'s `start_ollama()` exports
  `OLLAMA_KEEP_ALIVE=-1` (Ollama's own default is `5m`, confirmed via
  `ollama serve --help`), so the model is never unloaded for idling —
  `ollama ps` shows `UNTIL Forever` once it's loaded. Measured on this
  machine 2026-08-04 (private-gpt `:8080` `/v1/messages`, `stream: true`,
  plain chat, no RAG — the previous 291-680s numbers below were recorded
  while an unrelated orphaned `llama-server` process was pinning a full CPU
  core; that process is gone now, so this is a clean re-measurement, not
  just a keep-alive effect):

  | | time-to-first-token | total |
  |---|---|---|
  | **cold** (model not loaded) | 22.1s | 24.3s |
  | **warm** (model resident) | 2.4s | 4.5s |

  Undo the residency setting: `export OLLAMA_KEEP_ALIVE=5m` (or unset it)
  before `starra up`, or edit the line directly in `start_ollama()`. Full
  method, raw output, and `ollama ps` evidence in
  `.superpowers/sdd/p2-task-1-report.md`. **Not a durable guarantee:** Ollama's
  `serve` process is unmanaged on this machine (no launchd job — confirmed by
  elimination, see the report), so `OLLAMA_KEEP_ALIVE` only takes effect when
  `start_ollama()` itself launches a fresh `serve`; residency is lost after a
  crash or reboot until the next `starra up`.
- **Local replies can still take a while under load.** The previous
  measurement (291-680 seconds) was recorded under heavy, unrelated CPU
  contention — see `.superpowers/sdd/task-1-report.md` — not a property of
  private-gpt itself; treat the table above as the realistic baseline on an
  otherwise-idle Mac. The 900-second ceiling is **private-gpt's**, not the
  route's — it is that service's own scheduler timeout
  (`PGPT_CHAT_CALLBACK_TIMEOUT_SECONDS=900`, exported by
  `private-gpt-up.sh`). The route sets no timeout of its own: its
  fetch to private-gpt is aborted only by an operator disconnect, and the
  `maxDuration = 180` at the top of `src/app/api/chat/route.ts` is an inert
  hint here — Next only reads it at build time to hand a deployment platform
  (Vercel) a function timeout; nothing under `next/dist/server/` enforces it,
  so self-hosted `next start` ignores it entirely.
  Long silences on the deck/call stream during that wait are NORMAL, not a
  hang: private-gpt sends `ping` frames the whole time, which keep the
  route's *internal* fetch to private-gpt alive, but `streamPrivateChat`
  (`src/app/api/chat/route.ts`) only forwards `text_delta` and `error`
  events to the browser — pings are dropped, not relayed — so the
  client-facing stream is genuinely byte-idle until the next real token. If
  a future client-side idle timeout ever kills long private replies, this is
  the first place to look: the route would need to forward its own
  keep-alive to the browser, since the vendor's pings never reach it today.

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
