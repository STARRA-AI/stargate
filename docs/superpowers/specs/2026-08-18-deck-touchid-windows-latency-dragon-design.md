# Deck: Touch ID · Chat Windows · Speech Latency · Dragon Tradar — Design

**Date:** 2026-08-18
**Repo:** `~/STARGATE/stargate` @ `3856b59`
**Requested by:** Classic, 2026-08-18

---

## 0. Bench state, measured today (not assumed)

| Gate | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | clean, 0 errors |
| Tests | `npm run test:v2` | 1546 tests, **0 fail**, 1 skipped |
| Deck | `curl -sk https://localhost:3000/login` | `200` — running |
| API routes | `/api/vitals`, `/api/dragon`, `/api/feed`, … | `401` without the session cookie (correct, not a fault) |

**"Debug the stargate" does not resolve to a red bench.** Nothing is failing on the
bench. The defects are the four named features, each of which is broken or absent in a
way no test currently covers. Section 1–4 below name each root cause from source.

The one skipped test is `tests/speak-chunk-queue.test.ts` — a real 558-line spec,
deliberately `skip`ped by a prior session because the primitive it specifies could not
be built inside that session's file set. Section 3 unblocks it.

---

## 1. Touch ID — ROOT CAUSE, from disk

**Symptom (Classic's words):** "make the touch id feature work. it's currently a passkey."

**Evidence — the registered credential on this machine:**

```
$ node -e "for (const p of require('./data/passkeys.json')) console.log(p.transports)"
[ 'hybrid', 'internal' ]
```

`hybrid` is the WebAuthn transport formerly named caBLE: **cross-device authentication,
the QR-code-and-your-phone flow.** `internal` means a built-in, non-removable
authenticator — Touch ID. The stored credential advertises **both**, so every login
tells the browser "this credential might live on a phone," and the browser shows the
generic passkey picker instead of going straight to the Touch ID sheet.

**Why it got that way — `src/app/api/auth/passkey/register/route.ts:54-57`:**

```ts
authenticatorSelection: {
  residentKey: "preferred",
  userVerification: "preferred",
},
```

`authenticatorAttachment` is **absent**. Per MDN, `"platform"` means "the authenticator
is part of the device WebAuthn is running on … a public key credential bound to a
platform authenticator is called a platform credential." With the field omitted, the
browser is free to offer roaming authenticators — iCloud Keychain sync, phone-via-QR,
a security key. That is the sheet Classic is seeing.

`userVerification: "preferred"` compounds it: per MDN, `"preferred"` "will not fail if
user verification cannot be performed" — so even the biometric itself is optional.

**Then it is re-advertised at every login — `login/route.ts:37-40`:**

```ts
allowCredentials: list.map((p) => ({
  id: p.id,
  transports: p.transports as AuthenticatorTransportFuture[] | undefined,
})),
```

The stored `hybrid` goes back out on the wire as a hint. Even after registration is
fixed, this one credential keeps summoning the cross-device sheet until it is replaced.

**The fix has four parts, all small:**

1. `authenticatorAttachment: "platform"` + `userVerification: "required"` on registration.
2. A server-side gate at verify time: `@simplewebauthn/server@13.3.2` puts
   `authenticatorAttachment?: AuthenticatorAttachment` on both `RegistrationResponseJSON`
   and `AuthenticationResponseJSON` (`node_modules/@simplewebauthn/server/esm/types/index.d.ts:78,98`).
   Reject a registration that did not come from a platform authenticator, rather than
   silently storing another hybrid credential.
3. Never send `hybrid` in `allowCredentials` for a credential we recorded as platform.
4. A way for Classic to **delete** the stale credential without editing JSON. There is
   no delete route today; `data/passkeys.json` is mode `0700` and hand-editing it is not
   a thing to ask of him.

**Deliberately unchanged:** `passkeyBlocker()` (`src/lib/webauthn.ts:76-81`) and the
`https://localhost:3000`-only constraint. WebAuthn forbids an IP as rpID; that is the
spec, not a bug, and the existing copy already says so.

**Observable result:** at `https://localhost:3000/settings`, "Set up Touch ID" raises the
**macOS Touch ID sheet** — fingerprint glyph, no QR code, no "use a phone" option — and
the next visit to `/login` unlocks on a fingerprint.

---

## 2. Chat windows — the constraint that decides the design

The deck is **not** a fluid layout. `src/components/bridge/useStageScale.ts:5-6`:

```ts
const DESIGN_W = 1680;
const DESIGN_H = 1000;
```

Every pixel of the bridge lives inside a fixed 1680×1000 canvas that is `transform:
scale(k)`-ed to fit the viewport, positioned `position: fixed; inset: 0`
(`src/styles/deck.css:55`), with the grid at `inset: 92px 22px 18px 22px`
(`deck.css:143-145`).

**The landmine:** `PointerEvent.clientX/clientY` are viewport pixels. The dragged element
lives in scaled space. A drag that adds the raw delta drifts away from the cursor by a
factor of `1/k` — on a 1280-wide window, `k ≈ 0.76`, so the window moves ~31% too far on
every drag. This is the single thing that makes a hand-rolled drag feel broken, and
`useStageScale` does not currently expose `k` to anyone.

**Design:**

- `useStageScale` publishes the scale as a CSS custom property `--stage-scale` on the
  stage element. CSS and JS can both read it; nothing else changes.
- A pure, DOM-free geometry module owns every number: convert a viewport delta to stage
  space, clamp a window to the stage bounds, toggle expanded/collapsed. All tests live
  here — no jsdom, no Playwright required to prove the maths.
- One `<DeckWindow>` wrapper supplies the chrome: a drag handle, a corner resize grip,
  and the **pull tab** Classic asked for — grab the tab, the window expands to a large
  reading size; grab it again, it returns to its docked size.
- Geometry persists per window id through a `deck-windows.ts` module modelled exactly on
  the existing `src/lib/voice/deck-prefs.ts` (same `typeof window === "undefined"` guard,
  same defensive read, same `CustomEvent` broadcast).
- Applied to the operator console (`.console`, currently pinned at `height: 32%;
  min-height: 210px` — `deck.css:520-524`), which is the chat box he means, and then to
  the in-call chat.

**Not doing:** a windowing library. The deck already has zero dependencies for this and
the whole surface is one drag, one resize, one toggle.

**Observable result:** he can grab the console's title bar, drag it anywhere on the deck,
pull its tab, and read a whole conversation at once — and it is still there after a
reload.

---

## 3. Latency — one half is measured, the other half is already built and switched off

### 3a. Chat speech: the whole reply is synthesized before a word is spoken

`src/lib/stargate-context.tsx:611`:

```ts
const speakPromise = speakStarra(speakableText(full), ttsAc.signal);
```

`full` is the **complete** reply, only available after the SSE stream closes. `/api/tts`
takes 0.82s for "Copy." and 4.02s for a paragraph (measured, `docs/HANDOFF.md` §6) —
synthesis scales with length, and it does not start until generation ends.

**Why it was not simply fixed:** `speakStarra` opens with `stopAllSpeech()`
(`src/lib/voice/speak.ts:885`). Calling it once per sentence cuts off the previous
sentence. It needs a queue that plays ordered chunks under one utterance generation.

That queue **already has a written spec** — `tests/speak-chunk-queue.test.ts`, 558 lines,
TDD-first, defining `speakStarraChunks(chunks, signal)`. It is `skip`ped with an exact,
verified reason (`tests/speak-chunk-queue.test.ts:280-317`):

> `stopAllSpeech()` calls `stopHostedSpeech()` + `stopLocalStream()` and mutates NO
> observable state; the only generation mutator is `beginUtterance()` … So an external
> queue has no way to learn the operator barged in between chunk N and chunk N+1 — it
> would keep talking.

**So the unblock is one primitive:** a stop-epoch in `speak.ts` — `stopAllSpeech()` bumps
a counter, exported as a read; the queue refuses to advance once it moves. Then the
spec un-skips and defines green.

**Two duplicate splitters must not both survive.** `src/lib/voice/sentence-chunker.ts`
(uncommitted, imported by nothing) reimplements what `speech-shaping.ts:864` already does
better: `takeSentences(buffer)` returns `{ sentences, rest }`, coalesces runt fragments
below `MIN_SENTENCE_CHARS`, caps chunk length, and is already in production on the call
path (`useVoiceCall.ts:1650`) with tests in `tests/call-sentence-streaming.test.ts` and
`tests/local-voice.test.ts:178`. The chunker and its two tests get **deleted**; the chat
path uses `takeSentences`, the same splitter the call uses.

### 3b. The call: the optimization is built, gated, and never measured live

`src/lib/voice/useVoiceCall.ts:553-554`:

```ts
export const CALL_STREAM_SENTENCES =
  process.env.NEXT_PUBLIC_STARRA_CALL_STREAM_SENTENCES === "1";
```

Off by default, deliberately: "it does not come on until Classic has personally heard a
live multi-sentence turn work" (`useVoiceCall.ts:545-548`).

A per-turn timing rig also already exists and is also off —
`CALL_TIMING_DEBUG` (`useVoiceCall.ts:566-567`) records six `performance.now()` stamps per
turn into `window.__starraCallTiming` and computes `t1EarsMs / t2BrainFirstByteMs /
t3GenerateMs / t4MouthMs`, plus `streamedTotalMs`: what the wait **would** be with
sentence streaming on, and `streamSavingMs`, the measured price of the flag being off.

**So "optimize the call end to end" is not a refactor. It is: measure, flip, re-measure,
then fix whichever leg the numbers name.** Guessing which leg is slow, with a rig sitting
right there that answers it, would be the worst version of this work.

**Explicitly out of scope, Classic's words:** the animation engine — "which we are going
to fix later." The call work must not change `StarraClipFace`, `ReactorSphere`, or the
analyser bus.

**Observable result:** a number he can read — "T3 was 2.4s of a 3.1s wait; with streaming
on it is 0.9s" — and a call where she starts answering before she has finished thinking.

---

## 4. Dragon Tradar — verified live today

```
$ curl -s -o /dev/null -w "%{http_code}" https://dragonradar.net/api/agent/v1/stats
401
$ curl -s https://dragonradar.net/api/agent/v1/stats
{"error":"missing_agent_token"}
```

The API is up and the auth model matches the handoff exactly: bearer token is the whole
identity, no userId anywhere.

**What exists in the deck already:** `src/lib/keys.ts:31,85-107` has a `dragontradar`
key group with `kalshi_key_id`, `kalshi_private_key`, `dragontradar_url`,
`dragontradar_token`. Those last two are for a **stats/telemetry** endpoint on a
different host (`dragontradar.com/api/stats`, read by
`src/app/api/telemetry/route.ts:45-48`). The trading agent at `dragonradar.net` is a
separate credential and gets its own slot. `src/app/api/dragon/route.ts` reads Kalshi
market data directly and stays as it is; the agent API is additive.

**The money rule (charter §0).** This places real orders with Classic's real money on his
one month of runway. The design is therefore:

- **Reads are free.** `GET /stats` — she can look at balance, positions and performance
  whenever she likes, IP-rate-limited to a few times a minute as the handoff says.
- **Writes are proposals.** STARRA never calls `POST /orders` directly. She writes a
  **ticket** — ticker, side, action, count, price, and her reason — into a local store.
  The ticket appears in the DRAGON TRADAR panel with APPROVE / DECLINE. Only Classic's
  approve fires the order.
- **The bearer token never leaves the server.** Every call goes through a deck route; the
  token is read with `getKey()` server-side and is never logged, never echoed, never in a
  response body, never in the browser bundle.
- **403 halts.** Per the handoff, a 403 is "the human paused me" — the client stops
  trading, marks the ticket, and surfaces it. It does not retry.
- **5xx polls before assuming.** `GET /orders/{clientOrderId}` decides whether an order
  landed; the same `clientOrderId` is reused on a 502 retry, never regenerated.
- **429 backs off.** 30 orders/min per user is the stated ceiling.
- **Size rejection reduces `count`.** Never loop-retry the same size.

She reaches all of it from every surface through the two tool planes that already exist:
`/api/mcp` (JSON-RPC, `src/app/api/mcp/route.ts:60-97`) and
`/api/voice-tools/[action]` (plain spoken sentences, bearer-gated, write verbs listed in
`WRITE_ACTIONS` — `src/app/api/voice-tools/[action]/route.ts:37`).

**Observable result:** he says "STARRA, what's my Dragon balance" and she answers with the
real number; he says "buy ten yes on X at 45" and a ticket appears on the deck with
APPROVE on it; he clicks it and the order goes.

---

## 5. Scope boundary

**In:** Touch ID, chat windows, chat + call speech latency, Dragon Tradar reads and the
gated write path.

**Out, and named so it is not a surprise:**
- The animation engine — Classic deferred it explicitly.
- Tailscale Funnel (blocked on his password + browser login; `docs/HANDOFF.md` §3).
- Anything that turns on live trading without his click.
