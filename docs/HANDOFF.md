# HANDOFF — 2026-09-22 (later still)

## THE GOAL (his words, `/goal`)
The most life-like, alive, Jarvis-style assistant — a real person who is his friend and wants to
help. Judge every change against that. Memory: `north-star-alive-friend.md`.

## DONE — all committed on `addendum/gaps`, tree clean
| sha | what |
|---|---|
| `6428071` | lint is a gate again (build dirs ignored; 1,766 fake errors gone) |
| `ed0d9b4` | Dragon Tradar voice verbs (read / engage / disengage), chat lane only |
| `4d0152b` | chat latency: serial reads + memory write off the first-token path |
| `aaab9a5` | operator console: typing = zero React renders; file DROP BOX |
| `71f50e5` | vault: 413 on missing content-length, .docx/.xlsx read for real, binary guard, id collision |
| `26d238f` | viseme bank widened 16→25 on the old footage (superseded below) |
| `6cd387e` | `scripts/starra up` serves the PRODUCTION build by default (122KB JS not 659KB) |
| `8bbc2ec` | Dock app: `open -n -a` + exit — every click launches (exec made Chrome inherit the PID) |
| `7b30426` | her live face cut from two InfiniteTalk renders (superseded by dd471b2's geometry) |
| `954b588` | ignore `__pycache__` |
| `dd471b2` | **TWO BODIES, WAIST UP** — listening loop + speaking loop (552x840 full frame), mouth bank at (248,278,152,102), confidence-gated patch on the speaking body, 80ms mouth blend |
| `5c1a346` | `starra stop` kills the whole deck tree + waits; `up` refuses a held port and prints the listener; build log is its own file |
| `6a55f4d` | speaking-body gate is a hysteretic state machine (ON ≥0.95, OFF <0.93, 500ms dwell, ~50ms dissolve); interim window 240/266 confident, 9 switches, patch shown 78% |
| `03c7f87` | one `starra up` at a time (mkdir lock), atomic production build, a dist is current only when complete |
| `1548800` | **the body was indexed at the BANK's 25fps, not its own 24** — tables ran up to 11 frames ahead, mouth 31px off at 8s into every speaking loop. `bodyFrameAt()`; pinned |
| `86ce949` | **five more from the source review**: gate is a tested state machine (120ms off-debounce, no on-dwell, real clearly-turned), ONE 50ms dissolve (the 180ms CSS ease under a JS ramp was the blur), switch re-issued after a rollback, `speak_loop` primed at call open, canplay one-shot; bank null not memoized; `/avatar/*` revalidates every load |

Also today, outside the repo: Claude Code update loop fixed (stale lock) → 2.1.278; Agent-Reach
verified current (v1.5.0); llama.cpp Intel/AMD fork built + benchmarked at
`~/STARGATE/vendor/llama-cpp-intel-amd` (2.7x generation, 17% slower prompt; NOT integrated).

## IN FLIGHT
Nothing. Deck is LIVE on the prod lane (`node scripts/deck-server.mjs`, https://localhost:3000),
BUILD_ID **08:00:02**, serving the `86ce949` bundle (verified: the served chunk carries the new
50ms transition; `/avatar/body/speak_loop.mp4` answers `Cache-Control: public, max-age=0`).
LANDMINE seen once today: `starra up`'s own build failed on a transient next/font/google
(Orbitron) module-not-found and it SERVED THE PREVIOUS BUILD — it says so in its output
("Serving the PREVIOUS production build"). A direct `STARRA_DIST=.next-prod-new npm run build`
succeeded a minute later; swap with `starra stop; rm -rf .next-prod; mv .next-prod-new .next-prod;
starra up`. Always read the BUILD_ID time after an `up`.
The head-still, camera-facing speaking render (`4b92fb32`, $1.76) was cut and measured with the
same command and gate simulation as the interim: patch shown **31% vs 78%**; by eye she turns and
tilts in both. InfiniteTalk's head motion follows the audio, not the prompt. Interim window stays;
the take is filed at `STARRA ANGLES /muapi-out/starra_speaking_frontal_720p_infinitetalk.mp4`.

## THE EXACT NEXT STEP — his
Open a call and watch her (assets now revalidate on every load; a hard-reload is still the safe first move). Then tell me what
reads wrong — in what he SEES, not what he thinks causes it.

## UNVERIFIED (nobody has watched a live call with any of this)
- The face fixes of `1548800` + `86ce949` on a live call: the mouth now tracks the 24fps body (it was up to 31px off), the gate no longer hides the patch on a frontal face, switches are 50ms cuts. QC of the misindex: scratchpad `fps_misindex_qc.png` (this session).
- The two-body face on a live call (`dd471b2`): the listening→speaking crossfade on her first word, the
  patch fading to her own mouth on turns, the 80ms mouth blend. QC images:
  scratchpad/it-render/speaking_body_qc.png, SHIPPED_fullframe_bank.png.
- Console typing feel + drop box in his hands (`aaab9a5`).
- Prod lane on a real call (`6cd387e`).
- Dragon verbs end-to-end to an order (traced from source, never fired).

## MONEY (read live 2026-09-22)
- Muapi balance **$14.435** (spent $4.40 today on three renders: idle $0.88, speaking $1.76, head-still $1.76 — the third bought nothing; nothing recurring). Nothing spent since.
- xAI: $315.61 credit; every invoice $0.00; auto top-up is ARMED at a $5 floor (his switch).
- GCP: $13.75 this period, GPU VM stopped, $40 budget set.
- Higgsfield: 27 free credits, untouched.

## IF THE FACE READS WRONG — the levers, in the order to try
0. Which body is wrong? Listening = base_loop (idle render). Speaking = speak_loop. If the SWITCH
   itself is the problem: `SPEAKING_BODY_HOLD_MS` (700) / `SPEAKING_BODY_POLL_MS` (120) in
   starra-clip-map.ts. If the patch flickers on the speaking body: `SPEAK_CONF_FLOOR/FULL`
   (0.93/0.95) in viseme-sync.ts — keep the ramp narrow, a 50% blend reads as a seam.
   Mouth snapping: `MOUTH_BLEND_MS` (80) in StarraClipFace.tsx.
1. `TEXT_VISEME_MAX_SHAPE_GAIN` (text-visemes.ts) — left at 1.8 on purpose so the bank and the
   gain never changed together.
2. Box/mask geometry — `scripts/viseme-contact-sheet.py OUT.png public/avatar/visemes3` shows every
   entry composited; `scripts/measure_mouth_alignment.py` measures it.
3. Re-cut (full frame): `scripts/cut-idle-base.py --src <render.mp4> --out DIR --fit full --out-size 552x840 --seam-blend 9 --write`
   (add `--window-by frontal` for a speaking render),
   then `scripts/apply-base-measure.py --measure DIR/base_measure.json --write`, then the bank
   build line in the `7b30426` commit message. Needs the cv2 venv (see memory).
- `bodyMode: "alive"` gestures are OLD-footage family — leave it `"still"` until re-cut.
