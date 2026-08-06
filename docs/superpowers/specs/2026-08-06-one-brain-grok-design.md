# ONE BRAIN — Grok everywhere, private, streamed, capped

**Date:** 2026-08-06
**Status:** design approved, not yet implemented
**Model:** `grok-4.5` (Classic: "give her the best of the best"; budget line $50/mo)
**Approach:** A — stream sentences to TTS, so the best model costs nothing on the call
**Decision owner:** Classic (approved: privacy posture, fallback posture, model tier, approach A)

---

## Why

Today STARRA's brain is the free Groq lane, and it produced two failures Classic
felt directly:

1. **She stopped sounding like herself.** Her `STARRA_PERSONA_CORE` was a budget
   *candidate* on the tiered Groq path, costing 1,834 est tokens against ~626 of
   headroom — so it lost on **every turn, on every surface**, and was honestly
   recorded in `dropped` where nobody read it. Measured A/B, same model, same
   question, only that block differing:
   - without → *"What's the situation, and how can I help you get back on track?"*
   - with → *"Don't worry about it, I've got this. You sound like you could use a break, though."*

2. **She cannot carry her whole canon at conversational pace on Groq.** Measured
   against Groq's own `x-ratelimit-limit-tokens`: the best usable model is
   `llama-3.3-70b-versatile` at **12,000 TPM**. Her full canon is ~9,900 tokens
   per turn, so one turn consumes 83% of a minute's budget and the next turn 429s
   with a ~49s refill. That is not a conversation. `groq/compound` advertises
   70,000 TPM but rejects a 9.9k prompt outright ("Request Entity Too Large") and
   internally routes to a small `llama-4-scout` with its own tight limit.

xAI, which Classic already pays for and which already carries the call's voice
and ears, measured **15,000,000 TPM / 2,400 RPM** on his key. The rate wall
disappears entirely, and her full canon fits with no clipping and no starvation.

## Goals

- One hosted brain — Grok — on the operator console **and** the live call.
- Her whole canon on every turn. **Nothing of her is dropped to fit a budget.**
- Conversations not readable by xAI, verified rather than assumed.
- Under **$50/month**, with a hard mechanism that makes overrun impossible.
- Less code than today, not more.

## Non-goals

- Rewriting the call transport. The xAI Realtime socket keeps carrying ears and
  voice; only the brain and the text-delivery path change.
- Touching the local private lane's behaviour. It stays exactly as it is.
- Moving image/video (`grok-imagine-*`) or the avatar work.

---

## Measured facts this design rests on

All measured 2026-08-06 against Classic's own keys. Numbers, not vibes.

| fact | value | source |
|---|---|---|
| xAI rate ceiling | 15,000,000 TPM / 2,400 RPM | `x-ratelimit-limit-*` response headers |
| Groq best usable ceiling | 12,000 TPM (`llama-3.3-70b-versatile`) | `x-ratelimit-limit-tokens` |
| xAI trains on API data? | **No** — *"xAI never trains on your API inputs or outputs without your explicit permission."* | docs.x.ai/developers/faq/security |
| Default xAI retention | 30 days, encrypted, then deleted (abuse audit only) | same |
| ZDR available how? | **Console → Team Settings toggle**, not sales-gated | same |
| Classic's current ZDR state | `x-zero-data-retention: false`, `x-data-retention: general` | live header on his key |
| Prompt caching | automatic; `x-grok-conv-id` maximizes hit rate | docs.x.ai prompt-caching |
| grok-4.5 price | $2.00/M in, **$0.30/M cached**, $6.00/M out | docs.x.ai/docs/models |
| Her voice core | 9,836 est / ~10,029 real tokens | measured on the wire |
| Classic's usage | median 66 turns/day, heaviest day 329 | `data/memory.json`, 6 days |
| grok-4.5 cost @ median | **$11.05/mo cached**, $43.85/mo uncached | computed from the above |

**Latency, full canon, identical prompt:**

| model | total | TTFT | reasoning tokens |
|---|---|---|---|
| grok-4.5 | 5.70s | 484ms | 168 |
| grok-4.5 `reasoning_effort: minimal` | 3.57s | — | 53 |
| grok-4.20 reasoning | 9.09s | 328ms | 552 |
| grok-4.20 non-reasoning | 2.01s | 311ms | 0 |

The gap between TTFT (~0.4s) and total (~5.7s) is the entire design problem for
the call, and it is architectural, not a model property.

---

## Architecture

### 1. Provider consolidation

`src/lib/llm/hosted.ts` collapses from five hosted providers to two:

- **`grok` (primary)** — `grok-4.5`, pinned to its **dated** ID, never an alias.
  Classic's own G12 test exists because an alias silently repointed and moved
  billing 60%; the same class of bug must not be reintroduced here.
- **`kimi` (fallback)** — kept, renamed in comments to what it is (the free Groq
  slot). Default model corrected to `llama-3.3-70b-versatile`; the current
  default `moonshotai/kimi-k2-instruct-0905` **has been deleted from Groq** and
  only "works" because `GROQ_MODEL` masks it.
- **Removed:** `freellm`, `anthropic`.
- **Untouched:** `ollama` / private-gpt — the private lane is out of scope.

### 2. Privacy — verified, not trusted

Classic flips ZDR once in the xAI Console (Team Settings → Zero Data Retention).
The code then **enforces** it rather than assuming it:

- Every hosted xAI response's `x-zero-data-retention` header is read.
- A `false` reading raises a loud ops-feed ALERT and a visible deck state.
- Behaviour on `false` is a **hard gate**: the hosted Grok lane refuses, and the
  turn falls back to the free Groq lane. Privacy failure degrades service; it
  never silently proceeds.
- `/health` surfaces current ZDR state so it is checkable without making a call.

Rationale: a privacy toggle that is set once and never re-verified is exactly how
the July 2026 Grok Build incident became possible. The header exists; read it.

The local `private …` lane is unchanged and remains the answer for anything that
must never leave the machine, per Classic's chosen posture (ZDR **and** local).

### 3. Cost — caching is the whole ballgame

The $11 vs $44 spread is entirely cache hit rate, so caching is a first-class
requirement, not an optimization:

- **Canon-first ordering.** The stable ~9.8k identity prefix must be byte-identical
  every turn and must come **first**. All volatile content (live goals, tasks,
  memory, vault, threat brief) moves strictly **after** it. Any volatile content
  ahead of the canon breaks the prefix and costs ~4× forever.
- **`x-grok-conv-id`** set per call / per deck session so requests route to the
  same server and hit warm cache.
- **Never edit earlier messages** — append only. An edit or reorder invalidates
  the cache from that point on.
- **Metering**: `cached_tokens` from the usage payload is recorded per turn. If
  the hit rate collapses, that is a visible regression, not a silent bill.

### 4. Spend ceiling

A hard monthly ceiling (default $40, under Classic's $50 line, configurable):

- Every hosted turn's real usage is priced from the response's token counts and
  accumulated.
- At **80%** the deck warns.
- At **100%** the hosted lane stops and every turn falls back to the free Groq
  lane. She keeps working; the bill stops.
- The counter rolls on the calendar month and is persisted, so a restart cannot
  reset it into an overrun.

This makes a surprise bill structurally impossible rather than a matter of
watching a dashboard.

### 5. Streaming sentences to voice — approach A

This is the piece that makes "best model everywhere" free.

Today `runKimiTurn` awaits the **entire** reply, then calls `speakForced(spoken,
text)` once. Total generation time is therefore dead air: 5.7s on grok-4.5.

New behaviour: as the SSE reply streams, completed sentences are emitted to
`force_message` the moment each one closes. First audio then tracks **TTFT
(~0.4s)** instead of total time.

- Sentence boundary detection already exists — `src/lib/voice/speech-shaping.ts`
  splits on sentence terminators without regex lookbehind (a repo-wide constraint
  for the macOS WKWebView). It is currently module-private; the implementation
  must export it rather than write a second splitter that can drift from the one
  the reassurance filter uses.
- Existing per-turn shaping (crutch stripping, reassurance gating) applies to the
  **first** emitted sentence exactly as it does today; the opener gate is a
  head-of-turn concern and must not re-arm mid-turn.
- The transcript row is still written **once** per turn, from the accumulated
  text, so the call column does not gain a row per sentence.
- `kimiForcedPendingRef` currently pays for exactly one response per turn. It must
  now account for N force_messages per turn, or the one-voice guard will cancel
  her own sentences and mute the call — the failure Classic already lived through.
- Barge-in must abandon the remaining queued sentences, not just the current one.

**This is the highest-risk item in the plan and it touches the call's most
fragile invariants. It gets its own phase and its own tests.**

### 6. Markdown discipline

Measured cost of this move: Grok reaches for markdown more readily than the Groq
model did — on a voice-call prompt it produced bold headers and a numbered list.
`speakableText()` already strips fenced code for voice; it must be extended to
flatten headers, list markers and emphasis before text reaches TTS, with the
original preserved for the call transcript column.

---

## Error handling

| condition | behaviour |
|---|---|
| xAI 401 / 403 | ALERT + visible state, fall back to free Groq lane |
| xAI 429 | fall back for that turn (should be unreachable at 15M TPM) |
| xAI 5xx / network | fall back, surface which brain answered |
| `x-zero-data-retention: false` | hard gate — refuse hosted lane, fall back, loud ALERT |
| spend ≥ 100% of ceiling | fall back for the rest of the month, warn on deck |
| both lanes down | visible "link degraded", never silent |

**Non-negotiable, learned the hard way tonight:** no failure path may be a bare
`return`. A dead brain that produces no audio, no transcript row and no feed line
is indistinguishable from a working call — that is precisely how Classic sat
through a mute call with nothing to debug from. Every path reports.

---

## Testing

- **Provider pinning:** the dated model ID is asserted literally; an alias in the
  config fails the suite.
- **Prompt cache shape:** the canon prefix is byte-identical across two composed
  prompts that differ only in volatile content, and the canon is asserted to come
  first.
- **ZDR gate:** a mocked `false` header must produce fallback + alert, never a
  hosted call.
- **Spend ceiling:** crossing 100% switches lanes; the counter survives a restart.
- **Sentence streaming:** a multi-sentence reply produces N force_messages, ONE
  transcript row, correct pending-counter accounting, and a barge-in mid-reply
  drops the unsent remainder.
- **Voice markdown:** headers/lists/emphasis never reach TTS; the transcript keeps
  the original.
- **Live-call gate:** unit green is explicitly NOT sufficient for this work. The
  call must be made and heard before any of it is called done.

---

## Rollback

Every piece is independently reversible:

- Model/provider: `.env.local` values plus a one-line default.
- Streaming: gated behind a flag; off restores today's single-`force_message`
  behaviour exactly.
- ZDR gate and spend ceiling: both fail **open to the free lane**, never to a
  broken call.

---

## Open risk, stated plainly

The sentence-streaming change touches `speakForced`, the one-voice pending
counter and barge-in — the three things that have broken this call before. It is
worth doing because it is what makes the best model free on a call, but it is the
part most likely to need a second pass after Classic actually listens.
