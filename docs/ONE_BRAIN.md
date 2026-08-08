# ONE BRAIN — operator runbook

Plain reference for Classic. What answers, why, what can change it, and how
to check the privacy setting yourself. Standing order behind this: Classic's
ONE BRAIN order, 2026-08-06 (see `CLAUDE.md` Stack section, which supersedes
the earlier 2026-08-04 Kimi-locked order in place, keeping that history
readable rather than deleting it).

## Which brain answers, and why

**xAI grok-4.5** — on the operator console, the deck chat, and the live call.
Same brain, same voice, same her, everywhere. That is the whole point: one
prompt built once (`buildOneStarraPrompt()` in `src/lib/brain.ts`) and sent
byte-identical to every surface. A prompt that differs by surface is not a
feature difference — it is a bug, because it means she is not the same person
on the phone that she is in the chat window.

The free Groq / llama-3.3-70b-versatile slot (`LLM_PROVIDER=kimi`) still
exists, but only as the **emergency lane** — used when Classic forces it or
xAI is genuinely unusable, never as a routine daily driver. Whenever it is
active, she is told in her own prompt that she is on a backup brain, and
Classic is told too. Neither hears about it from silence.

## The one-prompt rule

`buildOneStarraPrompt()` composes her full canon once and caches it — every
caller gets the identical string. Per-turn context (memory, vault, pack,
runtime/style notes) is appended AFTER that fixed block, never mixed into it
and never sent ahead of it, so the cached prefix never has to be
recomputed. If a future change ever gives the deck one system prompt and the
call a different one, that is a regression of this rule, not a legitimate
customization — file it as a bug, not a feature request.

## The spend ceiling — she does not change brains at the ceiling

`STARRA_MONTHLY_CEILING_USD` is a **self-imposed budget guardrail**, not an
account-level failsafe. Hitting it does one thing: she keeps answering as
grok-4.5, and she says so — a line telling Classic (and her own prompt) that
the monthly ceiling has been reached. She is never quietly swapped to a
cheaper brain just because a number crossed a line. If Classic wants to
actually cut spend once that happens, that is his call to make, not something
that happens for him.

**What is allowed to change her brain:**
- Classic explicitly forcing the emergency lane (`STARRA_EMERGENCY_LANE=1`) —
  always announced, both to him and in her prompt.
- xAI becoming genuinely unusable (running out of API credits, not a
  transient hiccup).

**What is never allowed to change her brain:**
- A 429 (rate limit) or 5xx (server error) response. Those are a retry
  concern — retried on the same provider — and must never be read as a
  reason to swap who is answering. A blip is not a budget decision.

## Verifying Zero Data Retention (ZDR) yourself

Whether ZDR is on is read from xAI's own response header on every call, not
assumed from a setting that was flipped once and forgotten. You can check it
yourself at any time:

```bash
KEY=$(grep -E "^XAI_API_KEY=" .env.local | cut -d= -f2- | tr -d '"')
curl -s -D - -o /dev/null https://api.x.ai/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"grok-4.5","messages":[{"role":"user","content":"hi"}],"max_tokens":1}' \
  | grep -i zero-data-retention
```

Look at the `x-zero-data-retention` line in the output — `true` means it is
on for that request, `false` means it is not. **The toggle lives in the xAI
Console, and only Classic can flip it — nobody else can do it for him.**

**Unverified until he checks:** this doc does not claim ZDR is currently on
or off. It reads whatever the Console says at the moment the curl above is
run — check it live, don't trust a memory of a past check.

## The three env flags

Set in `.env.example` / `.env.local`:

| Flag | Default | What it does |
|---|---|---|
| `STARRA_MONTHLY_CEILING_USD` | `40` | Monthly xAI spend ceiling in USD. At the ceiling she stays grok-4.5 and says so — never a silent swap. |
| `STARRA_EMERGENCY_LANE` | unset (off) | Set to `1` to force the free Groq lane. Always announced to Classic and to her — never silent. |
| `NEXT_PUBLIC_STARRA_CALL_STREAM_SENTENCES` | unset (OFF) | `1` streams completed sentences into the call so first audio tracks time-to-first-token instead of the whole reply generating first. Gated. |

## Sentence streaming ships OFF

`NEXT_PUBLIC_STARRA_CALL_STREAM_SENTENCES` defaults off and **stays off**
until Classic has personally heard it work on a live call. Turning it on
before that is not this doc's call to make — it ships disabled on purpose,
not as a placeholder.
