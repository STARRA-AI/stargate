# STARRA / STARGATE — HARD CONSTRAINTS + HANDOFF STATE

You are working for **Charles "Classic" Williams** on STARGATE, his AI companion/operator.
Read this fully before your first action. These are constraints, not suggestions.
Written 2026-07-30 by the Claude Code session that built the current state.

---

## 0. THE STAKES

Classic **quit his job** to build this. As of 2026-07-26 he has roughly **one month to turn a
profit.** Wasting his time or money is real harm.

- **NO SPENDING.** Do not suggest, recommend, or nudge toward any paid tool, tier, API, subscription,
  credit, or GPU. **He raises spending — never you.** If something costs money, find the free path or
  say plainly there isn't one. Free/open-source is the default.
- **Bias every build toward REVENUE** — a working product he can show — over polish.

## 1. VERIFY FIRST — the #1 failure mode

Never state training/context knowledge as current fact. For ANY claim about what exists, versions,
prices, limits, API shapes, flags, or file contents — **verify FIRST** (read the file, run the
command, search). Tools outrank memory.

If you catch yourself about to say *"my list shows…"*, *"the latest is…"*, *"X doesn't exist"* about
anything external — **you have already failed. Go look it up.**

**Cite every claim** to a source: `file:line`, command output, or URL. "I think" is not verification.

## 2. HOW TO REPORT

- **Lead with the answer/solution.** Caveats after, short.
- **Never deliver a problem without a path** through it.
- **Admit uncertainty** — "I couldn't confirm X" beats a confident wrong answer.
- **Separate verified from unverified OUT LOUD.**
- **Claimed-done is NOT verified-done.** If a test fails, say so with the output.
- No snark, no "well actually", no moralizing.

## 3. THE ANIMATION RULES — read before touching any avatar code

Her photorealism exists because she **IS REAL FILMED FOOTAGE**. This is the hardest rule here:

- **NEVER GENERATE, SYNTHESIZE, INTERPOLATE, MORPH, OR AI-UPSCALE HER FACE.** Every output pixel must
  trace to a real source frame. Cutting, cropping, re-encoding = fine. Inventing pixels = task failure.
  Generation is exactly what produces the distorted hands and claws he explicitly forbids.
- **MEASURE, DON'T EYEBALL — then look anyway.** Both matter. This session made three wrong calls from
  bad measurements (a template tracker that lost lock and jumped onto her jacket; an "iris" detector
  that was locking onto her eyeliner). Looking at extracted frames caught all three. Do both.
- **Fast seek produces FALSE corruption.** `ffmpeg -ss` BEFORE `-i` creates fake rainbow artifacts.
  Always decode sequentially. Conversely `ffmpeg -f null -` reports "clean" on genuinely corrupt clips
  because the *bitstream* is valid while the *pixels* are datamoshed.
- **His stated goal:** "look like I'm talking to a real person." Eye contact + a still head is most of
  what reads as present. A synced mouth on a body that glances away and tilts is WORSE than no
  animation — the mismatch is what the eye locks onto.
- **Clip-swapping cannot flow.** A crossfade between clips IS the thing the eye reads as a cut. The
  target architecture is ONE continuous body with layered systems at different rates (breath ~0.2Hz,
  gaze fast, blink every 3-5s, mouth from live audio), all driven by one coupled state.
- **The blinking galaxy eye (`ReactorEye.tsx`) is OFF-LIMITS.** He said so explicitly.

## 4. HER VOICE OUTRANKS EVERYTHING

A silent STARRA is a catastrophe; a missing feature is not.

**The invariant, already broken once this session — do not break it again:**
In `src/lib/voice/speak.ts`, `audio.play()` must be reached with **ZERO intervening awaits**, and the
WebAudio analyser tap must stay **fire-and-forget inside `play().then()`**. An earlier change put an
unbounded `await ctx.resume()` in front of `play()` — under the autoplay policy that promise can pend
forever, so she went silent AND the whole turn wedged (`hudState` pinned to "speaking", wake loop
starved). Every `resume()` must be raced against a timeout.

Never add an await, throw, or early-return to her audio path without a fallback.

## 5. PLATFORM LANDMINES

- **macOS 12 / WKWebView target: NO regex lookbehind `(?<=)` in client code.** It throws on that WebKit.
- Guard newer APIs for undefined (`AudioContext.outputLatency` is absent there).
- `@/lib/engine` barrel is **server-only**. Client code imports `@/lib/engine/bus` or
  `@/lib/engine/redact` (both pure) instead. `src/lib/keys.ts` is transitively in the CLIENT graph via
  `src/app/settings/page.tsx` — a server-only import there breaks `/settings`.
- **NEVER** print, log, return, or render an API key. Masked (last-4) only. Scrub **before** truncating —
  truncate-first can split a key so the match misses and a live fragment leaks.
- `NEXT_PUBLIC_LIPSYNC` stays **"0"** (gates the PAID Replicate path). Replicate + Anthropic are
  `paid:true, defaultEnabled:false` and the router refuses them unless explicitly enabled.
- Don't `git commit`/`push`/`checkout` unless asked. Don't restart the dev server (`:3000`).

---

## HANDOFF — VERIFIED STATE as of 2026-07-30

**Repo:** `~/STARGATE/stargate` (Next.js 15.5.20, React 19, TS, Tailwind v4)
**Launch:** `bash scripts/starra up` → `http://127.0.0.1:3000`. Status: `scripts/starra status`.
**Baseline when this was written:** `npx tsc --noEmit` = **0 errors**; `npm run test:v2` = **515 pass,
0 fail**; eslint = 2 known pre-existing warnings (`no-img-element`, `no-unused-vars` in a script).
Session started at 201 tests. **Re-run these before you change anything** and don't claim a clean tree
you didn't verify.

### Done + verified
- **Launcher** `~/Applications/STARRA.app` — was dumping him on Chrome's New Tab Page (proof: that
  profile's Top Sites db had the deck at rank 0 and `most_visited_tile_navigation_count = 14`).
  `--app` is startup-only and every relaunch forwarded to the surviving Chrome. Fixed by quitting only
  that profile's Chrome first. Original at `STARGATE.bak.20260729`.
- **Security** — brute-force lockout (`src/lib/auth-lockout.ts`). **Loopback is NEVER locked** so he
  can't be stranded on his own Mac; proven: 12 wrong passwords from loopback = 401×12, LAN trips 429
  at #8. Closed a `.json` auth bypass in `src/middleware.ts:11`. `secure` cookie is conditional on TLS
  (a hard `true` silently breaks HTTP login). HTTPS auto-upgrades once the mkcert CA is trusted.
- **Engine** `src/lib/engine/**` + `/api/engine/*` + `OptionsPanel.tsx` — provider registry, capability
  router, runtime config at `data/engine.json` (0600, gitignored), state bus, Options menu.
  `getKey()` now resolves **engine.json override → data/keys.json → env**, so a key pasted in the panel
  actually reaches her voice.
- **2-D viseme bank** `public/avatar/visemes2/` — 15 visemes from `e heavy`, all verified 100%
  bit-identical crops of real frames, with a genuine closure (2px aperture) for /m/ /b/ /p/.

### The animation state — WHERE TO PICK UP
`talking.mp4` is **RETIRED as the speaking base**: eyes closed/downcast ~60% of it, 121px×73px head
travel, and it contains a **wink** at t≈1.33-1.43s (left eye shut, right open) — that's the "moving
like an idiot" he complained about.

New footage QC'd (all 1280×720 @24fps, 289 frames, her content pillarboxed in columns **364-915**,
face scale **0.670×** the keyframe's — so crop to `552:720:364:0` before measuring):

| clip | role | ruling |
|---|---|---|
| `~/Desktop/4ff00ead.mp4` | **base loop** | PASS — travel (10,17)px, no zoom (0.990), loops at 2.90, eyes on lens 12s, resting mouth |
| `~/Desktop/09d28038.mp4` | smile | PASS — peaks 16.24 @4.50s, returns to 4.66 |
| `~/Desktop/29fc2b70.mp4` | brow raise | PASS — peaks 23.14 @4.62s, returns to 3.83 |
| `~/Downloads/hf_*1322fd7a*.mp4` | listening tilt | PASS — roll ±12°, **ends at 0.0°** |
| `~/Desktop/06f584cd.mp4` | base take 1 | REJECT — 90px drift + zoom (0.900) |
| `~/Downloads/hf_*86bbdf79*.mp4` | nod | REJECT — holds head down 1667ms then 2917ms = a bow, not a nod |
| `public/avatar/clips/{nod,laugh,eyebrow,gaze_*,tilt_*}.mp4` | old gestures | REJECT — **slideshows**: nod is 5 unique images across 37 frames, 88.9% duplicate pairs, biggest jump 17.08 vs ~2.5 natural |

**Next steps:** rebuild the base loop + viseme bank from `4ff00ead` at native resolution (base and bank
only need to match *each other* — no upscale). Cut smile/brow/tilt to neutral→neutral boundaries so
they blend invisibly. Use **ping-pong playback** (forward then reverse) for the base loop — a reversed
breath is still a breath, so no splice point exists to see. One nod retake is outstanding.

**Same-take rule (measured, load-bearing):** `e heavy` ↔ `ooo heavy` = PSNR **43.30dB** (same
keyframe). `e heavy` ↔ `idle_a1` = **14.86dB** (different take). A bank cut from one take and pasted
on a base from another reads as a different woman's mouth. **Base and bank MUST be the same take.**
Keyframe for all new generations: `/Users/work/Desktop/STARRA_KEYFRAME.png`.

### Known-open, his call to make
- Piper's timeout bounds *playback* not synthesis → can cut her off at 4.0s and re-speak the whole
  reply in a different voice (`speak.ts` ~:606). Web Speech has no watchdog.
- Reverse shadowing: once the Options panel sets a key, `/settings` pasting is silently outranked.
- Reboot persistence: the crash guard dies on reboot (macOS TCC won't let launchd read `~/Desktop`).
  Needs Full Disk Access for `/bin/bash`, or move the repo out of Desktop.

### Canon — read these for who she is
`STARRA_MIND.md` (that she is — continuity, first-person authority, the Creed of the Lamp),
`STARRA_SOUL_BOOK.md` (The Creed), `STARRA_GUARDIAN.md` (The Covenant, the gates),
`STARRA_BRAIN.md` (facts, 8K prompt cap), `STARRA_PERSONALITY.md` (voice + the HARD RULE: truth
outranks abundance — **the love IS the truth**).

**Conflict order, highest first:** gates → HARD RULE → BRAIN facts → Covenant → Creed → Lamp →
Personality → memory.
