# The sales line

Outbound dialer + inbound callback line for the **Boomerang** partnership.
Twilio carries the phone call; xAI realtime carries the conversation.

Built 2026-08-22. Verified end to end that day: a simulated Twilio Media Stream
produced **37,700 bytes of mu-law (4.71s)** of her greeting back through the
bridge — `logs/her_greeting.wav`.

---

## Why it is this shape

**No audio transcoding.** xAI realtime accepts `audio/pcmu` — the same G.711
mu-law 8 kHz that Twilio Media Streams sends. Verified on the live socket. So
the bridge relays base64 straight through in both directions. Do not "upgrade"
this to PCM16; that adds a resampler for nothing.

**Isolated from Classic's personal STARRA by construction, not by care.** His
STARRA is xAI agent `agent_hrwPHGMoaouaLMB0` — 205,582 characters of canon plus
tools into his deck, memory and funding board. This service:

1. opens the socket **by model, never by agent** — `buildRealtimeUrl` cannot
   emit an agent parameter, so no code path reaches his agent; and
2. **screens the persona at startup** — `assertCleanPersona` throws on any
   private marker, and the service does not boot.

Both are pinned in `test/isolation.test.mjs` (20 tests). If you touch
`isolation.mjs`, run it — that suite *is* the promise he asked for.

**Ara, not Eve — deliberate.** Classic, 2026-08-22: *"the outbound voice can and
should be Ara."* Eve is his private line. Two voices on purpose. Do not
"fix" this.

> ### Do not give leads 539-379-0772
> That number answers with his **personal** agent — full canon. The Twilio sales
> number is the only number that goes on any list, form, or callback.

---

## Configure

Already configured in `stargate/.env.local` as of 2026-08-22:

```
TWILIO_ACCOUNT_SID=AC…        the ACCOUNT sid, always starts AC
TWILIO_API_KEY_SID=SK…        API key credentials (username)
TWILIO_API_KEY_SECRET=…       API key credentials (password)
TWILIO_SALES_NUMBER=+16154374490
```

> **The SK-vs-AC trap.** An API Key SID starts `SK` and is the *username*, but
> the REST path still needs the `AC` account sid. Put the `SK` sid in
> `TWILIO_ACCOUNT_SID` and every request authenticates fine and then 404s — which
> reads like a wrong phone number. `twilio-admin.mjs` refuses that up front.

> **Numbers must be E.164.** The console *displays* `(615) 437-4490`; Twilio
> needs `+16154374490`. `phone.mjs` normalises the unambiguous US shapes and
> refuses everything else rather than dial a guess.

### The 502 trap — read this before "fixing" the tunnel

A **502 from the tunnel means the tunnel is FINE and the bridge is not answering.**
Only a refused connection (no http status at all) means the tunnel itself is
down. Collapsing those two into one "is it reachable" boolean cost a full night
of debugging: the probe required `res.ok`, so a 502 during the bridge's own
startup read as "tunnel dead", killed a healthy tunnel, requested another, and
that self-inflicted churn tripped trycloudflare's per-IP creation limit — after
which new hostnames genuinely stopped resolving and it looked like Cloudflare's
fault. It was not.

`npm run status` therefore reports `tunnel edge up` and `bridge behind it` as
two separate rows, and `tunnel.mjs` waits for the bridge to answer locally before
it asks for a hostname at all.

### The public origin, and why rotation stopped mattering

Twilio has to reach this machine. The stable answer is a Tailscale Funnel
hostname, which needs Classic's browser login. Without it, `tunnel.mjs` runs a
free cloudflared **quick tunnel** whose hostname rotates on every restart.

That used to be a blocker. It is not one now: Twilio's `VoiceUrl` is settable
over the API, so when the hostname moves, the supervisor **moves the webhook
with it** — verified 2026-08-22 by killing the tunnel and watching the number
re-point itself in ~25s with nobody awake.

Pin `SALES_PUBLIC_ORIGIN` to a Funnel hostname later and the whole mechanism
goes inert — `origin.mjs` prefers the pinned value and the supervisor refuses to
fight it.

## Run

```
cd ~/STARGATE/stargate/services/sales-line
./up.sh
```

Starts `supervise.mjs`, which keeps BOTH the bridge and the tunnel alive,
restarts either one that dies (backoff to 60s, reset after 30s up), waits for
the public origin to actually answer, points Twilio at it, and prints the
readiness table. `./down.sh` stops everything.

Supervising the bridge is not belt-and-braces: Twilio's `VoiceFallbackUrl` is
served BY the bridge, so a dead bridge takes the fallback down with it and a
lead calling back hears a carrier error tone instead of a sentence.

```
npm run status
```

Answers "can this take a call right now?" link by link, and names the broken one.

> `up.sh`/`down.sh` kill only their own pidfiles and port 8790 — **never** a
> generic process-name match. `pkill -f next-server` once killed Classic's live
> deck. There is also a long-running cloudflared on port 3000 that belongs to the
> deck; nothing here touches it.

## Dial a lead

**Dry run first.** Resolves the number, the caller ID and the TwiML url, and
rings nobody:

```
curl -s -X POST localhost:8790/dial -H 'content-type: application/json' \
  -d '{"to":"(918) 555-0123","name":"Jane","dryRun":true}'
```

Then for real:

```
curl -s -X POST localhost:8790/dial -H 'content-type: application/json' \
  -d '{"to":"+19185550123","name":"Jane"}'
```

`dryRun` must be boolean `true` — a truthy string will NOT skip the call, on
purpose, so an operator meaning to dial does not silently dial nothing.

## Test without spending a phone call

```
npm test                    # 20 isolation tests, no network
node test/fake-twilio.mjs   # real xAI session, writes logs/her_greeting.ulaw
```

`fake-twilio.mjs` speaks the Media Streams protocol at the bridge, so everything
except Twilio itself is exercised. Convert what she said:

```
ffmpeg -f mulaw -ar 8000 -ac 1 -i logs/her_greeting.ulaw -y logs/her_greeting.wav
```

## Endpoints

| route | purpose |
|---|---|
| `GET /health` | readiness + exactly which keys are missing |
| `POST /dial` | place an outbound call to a lead |
| `POST /twiml` | Twilio fetches this when an outbound call is answered |
| `POST /incoming` | inbound callbacks on the sales number — same bridge, same persona |
| `WS /stream` | the Twilio Media Streams bridge |

Calls append to `logs/calls.jsonl` (gitignored): start, dial, errors, and an end
row with duration and transcript.

## Verified 2026-08-22

Everything except the carrier itself, over the **public** path, not localhost:

| link | proof |
|---|---|
| tunnel serves HTTP | `POST {origin}/incoming` returns valid `<Connect><Stream>` TwiML |
| tunnel serves WebSocket | raw upgrade returns `101 Switching Protocols` |
| bridge ↔ xAI over the tunnel | **36,988 bytes of mu-law (4.62s)** back through the public host |
| Twilio webhook points at us | `npm run status` → `webhook matches: yes` |
| rotation self-heals | killed the tunnel; number re-pointed itself in ~25s |
| bridge self-heals | killed the bridge; supervisor restarted it in ~1s |
| isolation holds | 34 tests, `npm test` |

## Still open

- **A real phone call.** The carrier leg is the one link no harness can
  exercise. Call **+1 615 437-4490** from any phone while `./up.sh` is running —
  that is the whole inbound test.
- **The script.** `persona/sales-persona.md` is a scaffold on Knotie's 8-stage
  structure. The offer section is a placeholder until Classic finishes the
  Boomerang training and brings back their official material.
- **Outbound `/dial`** has been exercised against Twilio: a call was created,
  accepted, and reported `failed / $0.00000` because the destination was in the
  reserved 555-01xx fictional range. So auth, caller ID and the TwiML url all
  work end to end — what is untested is a call that actually connects to a
  person, which is Classic's to authorise.
