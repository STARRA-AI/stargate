# FreeLLM router — the $0 overflow lane

Verified 2026-07-30: [tashfeenahmed/freellmapi](https://github.com/tashfeenahmed/freellmapi)
(17.4k stars) is a **self-hosted, local-first** OpenAI-compatible router that
stacks the free tiers of ~28 providers behind one `http://localhost:3001/v1`
endpoint. Your own keys, AES-256-GCM encrypted in a local SQLite; requests go
from this machine straight to providers. It also speaks Anthropic's wire
format, so Claude Code can point at it.

**Two honest caveats, up front:**
1. A rerouted session is answered by **free models, not Claude** — that is why
   it costs nothing. This is the *overflow* lane for when the quota window is
   burned, never the daily driver.
2. The repo says "personal experimentation, not production"; free-tier ToS
   compliance is on you.

## Part A — install the router (once, ~10 min)

```sh
# no curl|bash — clone and run explicitly (Node 24 already on this machine)
git clone https://github.com/tashfeenahmed/freellmapi ~/Desktop/STARGATE/freellmapi
cd ~/Desktop/STARGATE/freellmapi && npm install && npm run start
# dashboard comes up on http://localhost:3001
```

Then, on the dashboard's **Keys** page, paste free-tier keys (all free, no
cards — creating the accounts is the only human step):
- Groq — already in the deck's vault, reuse it
- Google AI Studio (Gemini) · OpenRouter · NVIDIA NIM · Cerebras · Mistral

Finally, generate the router's **unified key** and put it in the deck: Settings
→ Key Vault → **FreeLLM router (local)** (or `FREELLM_API_KEY` in `.env.local`).

## Part B — the deck brain (ALREADY WIRED)

- `LLM_PROVIDER=freellm` → explicit opt-in: the router carries chat with the
  full canon.
- Auto mode fallback order: **Kimi/Groq → FreeLLM router → Ollama → offline.**
  Kimi stays primary; Anthropic is never entered silently from freellm.
- No invented model slugs: the model resolves live from the router's
  `/models`; router down + no `FREELLM_MODEL` pin = clean throw = next rung.

## Part C — Claude Code overflow lane (`claude-free`)

A `claude-free` function is appended to `~/.zshrc`: it launches Claude Code
with `ANTHROPIC_BASE_URL` pointed at the local router and the unified key as
the session key — **session-scoped env only; the real Anthropic OAuth login is
untouched and never sent anywhere.** Plain `claude` stays exactly what it is.

```sh
claude-free            # zero-credit session on free models via the router
claude                 # normal full-quality session (unchanged)
```

## Verification checklist (run after Part A)

1. `curl -s localhost:3001/v1/models | head` — lists models from ≥2 providers.
2. Deck: set `LLM_PROVIDER=freellm` in `.env.local`, restart dev, send a chat
   message — reply lands, feed shows `FreeLLM brain — <model>`. Flip back.
3. `claude-free -p "2+2"` answers; the statusline quota does not move.
4. `npm run test:v2` stays green.

Supersedes the Kilo-Code fallback as the overflow lane (same purpose, stays
inside Claude Code UX).
