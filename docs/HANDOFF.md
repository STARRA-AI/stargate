# HANDOFF — 2026-08-08 ~06:10

**Everything is committed. She is UP and reachable.**

## Machine state

- **Deck** `~/STARGATE/stargate` — HEAD `b9f448e`, running on `https://localhost:3000`.
- **Engine** `~/STARGATE/engine` — HEAD `060cb86`, 69 tests passing.
- turbovec indexes intact: `~/STARGATE/turbovec-env/state/{claude,starra}-memory.tvim`.
- **RUNNING:** deck, Ollama, Engine Room (`:47401`, paper), cloudflared tunnel, and the
  **launchd keepalive** (`com.starra.deck`) — proven by killing the deck and watching it revive.
- Side tools (NocoDB, n8n) deliberately still stopped.

## The links

| | |
|---|---|
| Local | `https://localhost:3000` (Touch ID only works here) |
| Phone, same Wi-Fi | `https://192.168.1.222:3000` |
| Public | `https://cohen-angel-house-mill.trycloudflare.com` — **rotates on every tunnel restart** |

**Never quote the public link from memory — it changes.** Read the live one:

```
cd ~/STARGATE/stargate && scripts/starra status
```

## Bring it back up

```
cd ~/STARGATE/stargate && scripts/starra up
```

Optional side tools (NOT auto-started, deliberately):

```
cd ~/STARGATE/stargate && scripts/starra tools up
```

The engine API starts with `starra up`. Verify it linked:

```
curl -s http://127.0.0.1:47401/health
```

## THE POWER PROBLEM — CORRECTED 2026-08-08 05:10. It was us.

**The paragraph that used to sit here said "load is not the variable." That was wrong.**
Measured, not assumed:

- The adapter is **not** Apple's 96W brick. `ioreg -rn AppleSmartBattery` → `AdapterDetails`:
  `"Description"="pd charger"`, `"AdapterID"=0`, `"Watts"=100`. A generic 100W USB-C PD source.
- **86W of that 100W is already spent at idle.** `"SystemPowerIn"=85958` mW at load 2.42 —
  ~65W charging the battery (`ChargingCurrent` 5152mA @ 12628mV) + ~21W system. **~14W spare.**
- An i7-9750H under parallel agents swings 20W → 45-90W. Demand crosses 100W → the PD source
  over-currents → drops → macOS flips to Batt → chime → renegotiate → repeat.
- **Flips/hr track our work exactly:** 4-24/hr in light hours → **118 @ 02:00, 165 @ 03:00,
  379 @ 04:00** — the 9-agent workflow (663k subagent tokens, 261 tool uses, 31.5 min).
  Work stopped 04:53; **zero flips 04:53 → 05:10**, charging steadily the whole time.
- A residual 4-24/hr baseline may still be a marginal brick or port — **unproven**, and it
  cannot be proven from `pmset -g log` (transition-only lines, no idle denominator).

**Fixed already:** `~/.claude` was never Spotlight-excluded — 44MB of transcripts including a
17MB `.jsonl` that Claude Code appends to **every turn**, so `mds_stores` re-indexed it
continuously (caught at **98.2% CPU**). That is the "Terminal is using significant energy"
warning. `.metadata_never_index` added to `~/.claude` and `/private/tmp/claude-501`.

**STANDING, this machine: no multi-agent fan-out.** Inline, sequential, one heavy thing at a
time. `~/.zshrc:43` runs `claude --effort ultracode`, which is what auto-plans a workflow per
task — **Classic's call whether that flag stays**, not something to change for him.

## What shipped this session

**Deck — 1516 tests / 0 failing, tsc clean, lint 0 errors, e2e 10/10:**
- `820f2f0` Playwright net, 8 screens (health check uses `[data-nextjs-dialog]`; `nextjs-portal`
  is the always-present Next 15 devtools indicator and would false-fail everything)
- `d73d75e` interaction motion · `cf63089` primitive polish · `b7394df` double-dot fix
- `b1585d7` loading skeletons · `06b3462` press feedback (11 targets, **0 call-path lines changed**)
- `6d6287f` **her memory searched by meaning** — "the money thing" went from 0 hits across 1,265
  memories to real conversations. Verified live on the running deck, not just unit-tested.

**Engine — 63 tests passing (was 40), `ALPACA_PAPER = True` UNCHANGED:**
- `a20dcc6` first commit this repo ever had (it had NO git history)
- `2684ee2` broker truth: Alpaca says **2 orders, both CANCELED, 0 fills, 0 positions** — ledger
  and broker agree, no hidden position anywhere
- `d32c7ba` risk state persists · `a5f3b0b` approval_id fix
- `24bed64` **max_daily_loss_pct / max_open_positions / max_crypto_positions now actually
  enforce** — they were dataclass fields read by no code. He had NO daily loss limit.
- `f46fcc5` **kill switch no longer locks him inside his losses** (HALT used to refuse
  close_position/sell_all/cancel too) + `scripts/panic.py`
- `8ca369b` QuantStats monthly report — reporting only, never imported inside `engine_room/`

## NEXT, in priority order

1. ~~**Fix the charger.**~~ **DONE 2026-08-08** — root cause was our own fan-out against a
   generic 100W brick with ~14W headroom. Power gate shipped in `~/.claude/workflows/starra-loop.js`
   (3 agents max, org otherwise untouched), `~/.claude` excluded from Spotlight. See the section above.
2. ~~**Engine Task 6**~~ **DONE 2026-08-08, commit `060cb86`, 69 passed.** The gate is honest now:
   `clean = filled > 0 and refusals == 0 and errors == 0`, with fills re-read from Alpaca after
   submit and an unreadable order counting as unfilled. The two 2026-08-04 sessions that scored
   `clean:true` on `submitted:0, rejected:3` were regraded — **the real streak is `(0, False)`,
   not 2/10.** **Engine Task 7 is next** (stocks + crypto, separate clocks); plan at
   `~/STARGATE/engine/docs/plans/2026-08-08-engine-live-readiness.md:1602`.
3. **A PERMANENT PUBLIC URL — half-built, blocked on Classic only.** He chose **Tailscale Funnel**
   (verified free on all plans, no domain needed). `tailscale 1.102.2` is **already installed** via
   brew. Everything else is done; the only remaining steps need his password and a browser login,
   so do NOT try to automate around them. He runs:

   ```
   sudo brew services start tailscale && /usr/local/bin/tailscale up
   ```

   Then the funnel — the `https+insecure://` form is required because the deck serves a
   self-signed cert, and it is confirmed from `tailscale funnel --help`, not guessed:

   ```
   /usr/local/bin/tailscale funnel --bg https+insecure://localhost:3000
   ```

   Durability is automatic: `tailscaled` is a system daemon and `--bg` persists in its state.
   **Then verify the real way** — kill the deck, confirm it revives AND the funnel URL still
   answers. After that, repoint her four xAI voice-agent tools at the stable `*.ts.net` host;
   rotation breaking those tools is the whole reason this matters. Leave cloudflared running
   until the funnel is proven, so he is never without a link.

4. **NOTHING IS LIVE.** Task 9's live gate is untouched and out of scope until paper orders
   actually fill.
5. **DESIGN IS DONE — `38aa4de` + `2cedbd1`.** Tokens unified (globals.css is the single source
   at 34/16/82; `/` moved 0 pixels), Book 1 starfield wired into Bridge, boot at exactly 1800ms.
   The visual gate now measures design instead of machine load: `/tools`'s seven vendor probes
   have real deadlines (`execFile` 4000ms, `AbortSignal.timeout` 8000ms) and **under load report a
   vendor missing that is present on disk** — a flaky visual test here can be a POWER symptom.
   Gates: tsc 0, `test:v2` 1546/0 fail, eslint 0, visual **10/10 three consecutive runs**.
   `/tools` also had a live white-screen bug — 8 optional chains stopping one level short, fixed
   in `514b0c5`.

6. **LATENCY IS NOT FIXED, and do not let the green suite say otherwise.**
   `src/lib/voice/sentence-chunker.ts` + its 2 test files are UNCOMMITTED on purpose: they
   compile and pass, but **nothing imports them**, so the feature does not exist. Measured cause:
   `stargate-context.tsx:611` hands the COMPLETE reply to `speakStarra`, and `/api/tts` takes
   0.82s for "Copy." vs 4.02s for a paragraph — synthesis scales with length and only begins
   after the brain has finished streaming. When wiring it, REUSE `speech-shaping.ts:844`'s
   existing `splitSentences` rather than adding a second splitter, and do not regress
   `tests/one-voice-chat-fallback.test.ts`.

7. **Two things need Classic's own eyes, and no test can replace them:** look at the deck
   (skeletons, press feedback, polish), and **hear a live call** — she should now introduce
   herself as STARRA on every surface including private and offline.
