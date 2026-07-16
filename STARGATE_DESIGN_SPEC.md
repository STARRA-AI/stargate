# STARGATE — Design Spec

> Hand-off brief for the team/agent building STARGATE.
> This is the source of truth for how it should look, feel, sound, and behave.
> Build to this spec. Do not soften it into generic AI-app defaults.

---

## 1. Product one-liner

**STARRA** is the AI operator — the brain (Claude-class model).
**STARGATE** is the onboard HUD interface you talk to.

Think JARVIS from *Iron Man*: a personal ops console for a single operator that
remembers everything, ingests your business, and tells you the next move.
Works on desktop and phone from the same install. Voice-first, chat-second.

**It is not:** a chatbot, a wellness assistant, a productivity app with an AI tab.

---

## 2. Platform stance

- **Progressive Web App.** One codebase. Installs to iPhone home screen and
  desktop dock. No app store, no review cycle.
- **Responsive, not adaptive.** Desktop = wide command deck. Phone = stacked
  HUD with the mic as the hero. Same brain, same data, different composition.
- **Offline-safe read.** Last brief, recent memory, uploaded docs remain
  readable without network. Live model + voice require network.
- **Always dark.** No light mode. STARGATE is a bridge, not a document editor.

---

## 3. Visual identity

Locked to the four supplied assets: `wordmark.png`, `hud_ring.png`,
`hud_panel.png`, `badge.png`. Everything else derives from them.

### Palette (semantic tokens)

| Token | Hex | Use |
|---|---|---|
| `--void` | `#0a0414` | Base background |
| `--void-2` | `#140826` | Panel fill |
| `--chrome` | `#e9d5ff` | Wordmark / high-contrast readouts |
| `--purple` | `#a855f7` | Primary neon, ring glow, mic idle |
| `--magenta` | `#d946ef` | Accent, active state, "hot" data |
| `--star` | `#c4b5fd` | Cold-white for numeric readouts |
| `--danger` | `#ff3d81` | Alerts only — never decoration |
| `--ok` | `#8b5cf6` | Confirmations, "systems nominal" |

Every purple is oklch-tuned for AA contrast on `--void`. Never use pure white,
never use grays outside this ramp.

### Typography

- **Display / readouts:** Orbitron (600/700), wide tracking. Uppercase in HUD chrome.
- **Body inside panels:** Rajdhani (400/500) for medium-length text.
- **Mono / logs / metrics:** JetBrains Mono (400/500).
- **Long-form prose (Vault reader only):** Inter 400.

No Poppins. No default system-ui. No serif anywhere.

### Anti-slop rules — non-negotiable

- No default shadcn buttons or cards.
- No rounded-2xl soft cards with drop shadows. Chrome is etched, not floating.
- No emoji icons. No lucide `Sparkles` as identity mark.
- No purple-gradient-on-white. Ever.
- No "Hi! How can I help you today?" tone.
- No stock avatars, no generic "AI assistant" illustrations.

---

## 4. Layout — Desktop (≥1024px)

```
┌─ [ chrome frame from hud_panel.png ] ────────────────────────────┐
│  STARRA◇                                          ●SYSTEMS NOMINAL │
│                                                                    │
│  ┌── LEFT COLUMN ──┐        ┌── CENTER ──┐    ┌── RIGHT COLUMN ──┐│
│  │ BUSINESS SNAP   │        │            │    │ ACTION LOG       ││
│  │ MRR   $ 12,480  │        │  ◎ RINGS ◎ │    │ 09:12  brief run ││
│  │ TASKS 3 DUE     │        │   ★ BADGE  │    │ 09:04  gmail sync││
│  │ PIPELINE 7 OPEN │        │            │    │ 08:59  memory... ││
│  │                 │        │  STATE:    │    │                  ││
│  │ MEMORY          │        │  LISTENING │    │ CONNECTORS       ││
│  │ tier1  10 msgs  │        │            │    │ ● Gmail          ││
│  │ tier2  4 sums   │        │            │    │ ● Calendar       ││
│  │ tier3  128 arc  │        │            │    │ ○ Stripe         ││
│  └─────────────────┘        └────────────┘    └──────────────────┘│
│                                                                    │
│  ┌─ CONSOLE ──────────────────────────────────────────────────┐   │
│  │  > "Give me the brief."                                    │   │
│  │  ◆ Two items need you today. Stripe payout failed at...    │   │
│  │  [ mic ]  [ text input _______________________ ]  [ send ] │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                    │
│           starfield drift ← behind everything                      │
└────────────────────────────────────────────────────────────────────┘
```

- Center rings + badge are the state indicator. They are large. They dominate.
- Readouts are dense, aligned to a strict 4px grid, monospaced numbers.
- The console lives at the bottom and is always available — voice bar left,
  text input center, send right.

## 5. Layout — Mobile (<768px)

```
┌────────────────────────────┐
│ STARRA◇        ● NOMINAL   │  ← compact chrome bar
├────────────────────────────┤
│                            │
│                            │
│         ◎ RING ◎           │
│         ★ MIC ★            │  ← primary CTA. Tap = talk.
│                            │
│      TAP TO SPEAK          │
│                            │
├────────────────────────────┤
│ ◆ Last: "Two items need    │
│   you today..."            │
├────────────────────────────┤
│ [Today][Pipeline][Mem][Con]│  ← swipeable panel tabs
│                            │
│  today's 3 moves...        │
│                            │
└────────────────────────────┘
```

- The mic is the app. Text is the fallback (small link under the mic).
- Panels swipe horizontally. Never a hamburger.
- Everything one-thumb reachable from the bottom third.

---

## 6. Motion spec

| Element | Behavior | Timing |
|---|---|---|
| Outer ring | CW rotation, constant | ~40s / turn |
| Inner ring | CCW rotation, constant | ~18s / turn |
| Badge (idle) | Scale + glow breathe | 3s loop |
| Badge (listening) | Fast strobe pulse | 0.6s loop |
| Badge (speaking) | Waveform-modulated glow | driven by TTS amplitude |
| Badge (thinking) | Slow counter-spin inside rings | 2s loop |
| Starfield | Parallax drift, 2 layers | 60s + 120s loops |
| Response text | Glyph-by-glyph mono reveal | ~30ms/char |
| Boot sequence | Rings spin up, readouts populate line-by-line | 1.8s total |
| Panel transitions | 200ms ease-out slide, no bounce | — |

All motion respects `prefers-reduced-motion`: rings freeze, badge does a soft
opacity pulse only, no starfield drift.

**60fps floor on rings and badge.** Anything below that is a bug, not a taste
choice.

---

## 7. Voice interaction model

- **Full duplex.** STT in (Whisper-class), TTS out (ElevenLabs-class or
  OpenAI voice). Not push-to-talk-only.
- **Wake:**
  - Desktop: hotkey (default `⌥ + Space`) + optional wake word.
  - Mobile: tap the badge, or long-press for continuous.
- **Barge-in required.** If you start talking while STARGATE is speaking,
  TTS stops mid-word inside 150ms.
- **Silence detection.** 1.2s of silence ends the user turn.
- **VU meter is the badge itself.** No separate mic-level bar.

### Voice character brief

Calm. Low. Decisive. Dry. British-neutral or American-neutral — pick one and
stay there. Operator, not assistant.

**Yes:**
- "Copy."
- "Two items need you today."
- "Stripe payout failed at 08:41. Retrying in twelve minutes."
- "Standing by."

**No:**
- "Sure! I'd be happy to help with that!"
- "Great question! Let me think..."
- "Here are some ideas for you 😊"

Never uses the user's name more than once per session. Never apologizes for
being an AI. Never adds "let me know if you need anything else."

---

## 8. Business brain — what grounds the advice

STARGATE's "next steps" are only useful if it actually knows your business.
The build must support these ingestion surfaces, in this priority order:

### Tier 1 — Typed context (v1, required)
- Goals (quarterly + monthly)
- Projects (active + paused)
- Tasks (with due, owner, priority)
- Decisions log (what you decided and why — this is what makes advice consistent over time)

### Tier 2 — Uploaded documents (v1, required)
- PDF, DOCX, XLSX, MD, TXT
- On upload: parsed, chunked, embedded, summarized. Facts extracted into the
  Vault. Original stays viewable.

### Tier 3 — Memory tiering (v1, required — from your PLAN.md Phase 1)
- **Working memory:** last ~10 raw exchanges.
- **Rolling summary:** every ~30 messages, older chunks compressed to a paragraph.
- **Archival:** long-tail, searched by embedding, surfaced on relevance.
- Every prompt to the model includes: system + working + summary + top-k archival hits.

### Tier 4 — Self-refine loop (v1.1 — from your PLAN.md Phase 2)
- After any completed task, STARRA critiques its own output vs. the original ask.
- Critiques stored per project, tagged.
- Next similar task pulls those "past lessons" into the system prompt.
- **Guardrail:** this loop tunes prompts and lessons only. It does not rewrite
  STARRA's own source code. Any self-modification goes through git with a
  human diff review — same approval-gate principle already in the codebase.

### Tier 5 — Live connectors (v1.2+)
Wire in this order (each one behind an OAuth flow the user runs once):
1. **Google Calendar** — "what's on today," conflict warnings, hold blocks.
2. **Gmail** — inbox triage, drafting replies you approve before send.
3. **Stripe / revenue source** — MRR, failed payments, payout status.
4. **Notion / Google Docs / Drive** — pull recent docs into the Vault.
5. **Browser control (Phase 3 in your PLAN.md)** — via MCP-Chrome. Replaces
   the fragile keystroke-simulation path in the current STARRA repo.

Nothing here is a black box. Every connector has a status tile on the Bridge:
`● connected`, `○ available`, `◆ error — reauth`.

---

## 9. Core screens / views

| Screen | Purpose | Primary elements |
|---|---|---|
| **Bridge** | Home HUD, always-on command deck | Rings, badge, readouts, console |
| **Brief** | Morning read-out | What changed overnight, top 3 moves today, blockers |
| **Pipeline** | Deals / projects / offers | Kanban-lite, each card has an AI next-step suggestion |
| **Memory** | Searchable archive | Tier badges (working/summary/archival), semantic search |
| **Vault** | Uploaded docs + extracted facts | List + reader, "ask about this doc" inline |
| **Connectors** | Integration status | Tiles with reauth / disconnect controls |
| **Settings** | Voice, wake, model, theme intensity | Sliders, not toggles where possible |

The Bridge is always one tap away from every other screen (badge in the
top-left of every non-Bridge view returns home).

---

## 10. Copy / voice-of-product

### System states — sample microcopy

| State | Copy |
|---|---|
| Boot | `MEMORY ONLINE` → `GATEWAY LINK ESTABLISHED` → `SYSTEMS NOMINAL` |
| Idle | `STANDING BY` |
| Listening | `LISTENING` |
| Transcribing | `TRANSCRIBING` |
| Thinking | `PROCESSING` |
| Speaking | `TRANSMITTING` |
| Tool running | `EXECUTING — GMAIL` (name the tool) |
| Error | `LINK DEGRADED. RETRY?` |
| Offline | `OFFLINE. RECENT CONTEXT AVAILABLE.` |
| Empty inbox | `NOTHING PENDING.` |
| Empty pipeline | `NO ACTIVE FRONTS.` |
| Confirm destructive | `CONFIRM. THIS CANNOT BE UNDONE.` |

Every string in the product is in this register. No exceptions in modals,
toasts, or empty states.

---

## 11. Interaction state matrix

| State | Rings | Badge | Console | Sound |
|---|---|---|---|---|
| Idle | rotating | breathing purple | dimmed | — |
| Wake | flare pulse | strobe on | brightens | soft chime |
| Listening | rotating | fast strobe magenta | live waveform | — |
| Transcribing | rotating | steady bright | text appears | — |
| Thinking | inner ring counter-spin faster | slow counter-spin inside rings | shimmer placeholder | subaudible hum |
| Streaming reply | rotating | glow wave, sync to TTS | glyph-by-glyph reveal | TTS audio |
| Speaking | rotating | waveform glow | text finished, cursor at end | TTS audio |
| Tool-running | rotating | pulsing amber-purple | tool card expands (collapsed by default) | — |
| Error | rings jitter once | flash red-magenta | error toast in operator voice | soft thud |
| Offline | rings dim + slow | steady dim purple | offline banner top | — |

---

## 12. Sound design brief

Short cues only. Nothing that plays for more than 400ms except TTS.

- **Wake chime** — single soft synth swell, ~300ms, C+G open fifth.
- **Confirm click** — mono blip, ~80ms, high purple timbre.
- **Error thud** — low soft impact, ~200ms, no distortion.
- **Boot swell** — one-time, ~1.5s, layered synth pad rising to the wake chime.
- **TTS voice** — one voice, consistent across sessions.

No cartoon beeps. No R2-D2 chatter. No looped ambient.

---

## 13. Accessibility floor

- Every voice affordance has a keyboard and text equivalent. Mic button is
  focusable with a visible focus ring in `--magenta`.
- Contrast checked: all readouts ≥ 4.5:1 on `--void`. Numeric readouts use `--star`.
- `prefers-reduced-motion` path: rings freeze, badge softly opacity-pulses,
  no starfield, no glyph-by-glyph reveal (text appears whole).
- Captions on TTS: every spoken reply is also visible in the console.
- Screen reader labels on every icon-only control.

---

## 14. Build hand-off notes

### Suggested stack shape (constraints, not code)

- **Frontend:** PWA. Any modern framework. Web Speech API for STT if you
  want zero-cost, or Whisper API for accuracy. Web Audio API for TTS
  playback + barge-in.
- **Backend:** Server-side model calls only. Never expose the model API key
  in the client. One streaming endpoint for chat, one for voice.
- **Model:** Claude 3.5+ or GPT-4-class. Streaming responses required.
- **Storage:** Postgres (business data + memory tiers) + object store
  (uploaded docs) + vector store (archival memory + doc chunks).
- **Auth:** single-operator by default. Email + password + optional passkey.
- **Deploy:** anywhere with a Node/Python server + a Postgres. Fly, Render,
  Railway, or your own box.

### Asset placement

- `wordmark.png` → top-left of Bridge chrome, top-center of mobile bar. Never resized below 120px wide.
- `hud_ring.png` → decomposed into outer + inner rings for CSS/SVG rotation. Do not use the flat PNG as a static ring.
- `hud_panel.png` → the chrome frame around the desktop Bridge. Sliced 9-patch style so it scales.
- `badge.png` → center of the rings. Also the mic button on mobile.

### Secrets vs client-safe

- **Server-only:** model API keys, connector OAuth client secrets, DB creds, TTS keys.
- **Client-safe:** the app's own publishable auth key, connector *client IDs* (not secrets), feature flags.

### Explicit "do not" list

- Do not use a stock chat UI library that ships its own bubbles/avatars.
- Do not use a default "AI assistant" personality prompt.
- Do not add a settings toggle for "friendlier tone." The tone is the product.
- Do not ship without the four uploaded PNGs wired in as real assets.
- Do not swap purple for blue "because it's more trustworthy." No.
- Do not ship a signup page. This is a personal operator app.

---

## 15. Acceptance checklist

Before shipping v1, verify all of these visually and functionally:

- [ ] Rings animate at 60fps on a mid-range phone.
- [ ] Mic is the primary CTA on mobile (bigger than any other control).
- [ ] All four uploaded PNGs are wired in as real assets — no CSS stand-ins.
- [ ] Voice barge-in works: talking over TTS stops it within 150ms.
- [ ] Memory tier stats visible on the Bridge (working / summary / archival counts).
- [ ] Every string in the product is in operator voice — grep the codebase for "Sure", "Happy to", "Let me know" and remove.
- [ ] Boot sequence plays on cold load and is skippable after first view.
- [ ] `prefers-reduced-motion` path verified.
- [ ] Contrast audit passes on all readouts.
- [ ] PWA installs on iOS and desktop and launches without browser chrome.
- [ ] Uploading a PDF results in facts appearing in the Vault within 30s.
- [ ] Asking "give me the brief" returns a grounded reply that references
      actual data from at least one Tier 1 or Tier 2 source.

---

## Appendix — one-paragraph summary for pasting into a build agent

> Build STARGATE, a JARVIS-style personal ops PWA for a single operator.
> Aesthetic: purple/magenta neon HUD on void black, rotating reactor rings,
> chrome wordmark "STARRA," etched panel frame — locked to the four supplied
> PNGs. Desktop is a wide command deck with left/right readouts and a bottom
> console; mobile is voice-first with the mic-badge as the hero. Full-duplex
> voice with barge-in, operator-voice TTS ("Copy." not "Sure!"). The brain is
> Claude-class, streaming, server-side. Business grounding via typed context
> (goals/tasks/decisions), uploaded docs (parsed + embedded), tiered memory
> (working + summary + archival), and a self-refine critique loop. Live
> connectors roadmap: Calendar → Gmail → Stripe → Notion/Drive → browser
> control. No chatbot aesthetic, no default shadcn, no "friendly assistant"
> tone. Ship dark-only. Every string in operator register. This is a bridge,
> not a document editor.
