# STARGATE PWA — Design Spec

**Date:** 2026-07-15  
**Status:** Approved (architecture, screens/data flow, step contracts)  
**Repo:** `~/Projects/stargate`  
**Product:** Final STARGATE — JARVIS-style personal ops PWA for a single operator (STARRA LLC)

---

## 1. Intent

Build the **final** STARGATE as a Progressive Web App. Leave the existing Flask/pywebview app at `~/Desktop/STARGATE` alone (including its `web/` and `assets/` guardrails). This repo is the shipping UI.

**STARRA** = AI operator (Claude-class brain).  
**STARGATE** = onboard HUD you talk to. Voice-first, chat-second. Dark-only bridge — not a chatbot, wellness app, or document editor.

---

## 2. Canon inputs (do not invent brand/tone/business facts)

| Source | Role |
|--------|------|
| `STARRA_STARGATE_UNIFIED.md` (repo root) | Primary unified reference |
| `/Users/work/Downloads/STARGATE_DESIGN_SPEC.md` | Book 1 — HUD look/feel/behavior |
| `/Users/work/Desktop/STARRA_Master_Document_v3.pdf` | Book 2 — company, credit, vendors |
| `/Users/work/Downloads/STARRA_BRAIN (2).md` | Book 3 — runtime system prompt (8K cap) |
| `/Users/work/Downloads/STARRA Dashboard Enhancement/` | Visual reference (`STARGATE Standalone.html`) + brand PNGs |

Brand PNGs (prefer Enhancement pack): `wordmark.png`, `hud_ring.png`, `hud_panel.png`, `badge.png` → `/public/brand/`.

---

## 3. Architecture

**Stack**

- Next.js 15 (App Router) + TypeScript + Tailwind v4
- PWA: `manifest.webmanifest`, service worker, apple-touch-icon from `badge.png`
- LLM: Claude Sonnet-class via server route; streaming SSE to client
- Voice: OpenAI Realtime (full-duplex + barge-in); Web Audio for VAD / badge VU
- Storage: Supabase (Postgres + pgvector + Storage + Auth) when keys exist; local JSON/SQLite stubs otherwise so steps never block on missing keys
- Deploy target: Vercel

**Approach:** Vertical slices — ship a working Bridge early, then deepen (HUD → chat → Tier-1 → memory → Vault/Brief/Pipeline → voice → connectors/settings → PWA polish).

**Secrets:** Server-only — model keys, OAuth secrets, DB creds, TTS keys. Never expose in client.

---

## 4. Screens & routes

| Route | Purpose |
|-------|---------|
| `/` Bridge | Home HUD: rings, badge, snap/memory/connectors/action-log, bottom console |
| `/brief` | Overnight delta, top 3 moves, blockers |
| `/pipeline` | Kanban-lite deals/projects; each card has AI next-step |
| `/memory` | Working / summary / archival + semantic search |
| `/vault` | Uploads + extracted facts + ask-about-doc |
| `/connectors` | Status tiles: `● connected` / `○ available` / `◆ error — reauth` |
| `/settings` | Voice, wake, model, theme intensity (sliders preferred) |

- Desktop (≥1024): wide command deck; `hud_panel.png` chrome frame; rings+badge dominate center; console always at bottom.
- Mobile (<768): mic/badge is the app; text is fallback; swipe tabs `[Today][Pipeline][Mem][Con]`; no hamburger.
- Non-Bridge: top-left badge returns home.

---

## 5. Visual & motion (locked)

**Tokens:** `--void` `#0a0414`, `--void-2` `#140826`, `--chrome` `#e9d5ff`, `--purple` `#a855f7`, `--magenta` `#d946ef`, `--star` `#c4b5fd`, `--danger` `#ff3d81`, `--ok` `#8b5cf6`.

**Type:** Orbitron (display/HUD), Rajdhani (panel body), JetBrains Mono (logs/metrics), Inter only in Vault reader. No Poppins, no system-ui, no serif.

**Anti-slop:** No shadcn defaults, no soft rounded cards/shadows, no emoji UI, no friendly-assistant tone, no light mode, no signup page.

**Motion:** Outer ring CW ~40s; inner CCW ~18s; badge breathe/strobe/waveform by state; starfield 2-layer drift; glyph reveal ~30ms/char; boot 1.8s skippable after first view. `prefers-reduced-motion`: freeze rings, soft opacity pulse on badge, no starfield, full-text appear.

**Voice of product:** Operator register only — “Copy.” / “Standing by.” / “Two items need you today.” Never “Sure!” / “Happy to help” / emoji closers.

---

## 6. Data flow

```
Operator (voice | text)
  → HUD state machine (idle → wake → listen → transcribe → think → stream → speak | tool | error | offline)
  → POST /api/chat (SSE)  or  /api/realtime (voice session)
       system = STARRA_BRAIN (8K) + operator voice rules
       + Tier-1 (goals/projects/tasks/decisions)
       + working + rolling summary + top-k archival
       + vault hits when relevant
  → Stream into console readout (captions = spoken text)
  → Persist → memory tiers + action log
```

**Ingestion priority**

1. Tier-1 typed context (required v1)
2. Uploaded docs → parse/chunk/embed/summarize → Vault (required v1)
3. Memory tiers: working (~10), rolling summary (~30), archival embeddings (required v1)
4. Self-refine critique loop — **out of scope tonight** (v1.1)
5. Live connectors — **UI + stubs tonight**; live OAuth later

---

## 7. Tonight’s step ladder (definition of done)

| Step | Done when |
|------|-----------|
| **0 Bootstrap** | Repo ready: canon docs at root/`docs`, 4 PNGs in `/public/brand/`, `.cursorrules`, `.env.example`, git initialized |
| **1 HUD shell** | Desktop + mobile Bridge; motion + reduced-motion; boot; operator microcopy only |
| **2 Console brain** | SSE streaming into console (no bubbles); BRAIN injected; degrades without Anthropic key |
| **3 Tier-1** | Goals/projects/tasks/decisions editable; Bridge snap readouts live |
| **4 Memory** | Tier counts on Bridge; Memory screen searchable; prompts include three tiers |
| **5 Vault + Brief + Pipeline** | Upload → facts; Brief grounded; Pipeline with next-step lines |
| **6 Voice** | Wake (⌥Space / tap badge), barge-in ≤150ms, badge VU; stub if no Realtime key |
| **7 Connectors + Settings** | Status tiles + settings sliders; OAuth only if keys present |
| **8 PWA + gate** | Installable; offline read of last brief/memory; Book 1 §15 checklist verified or explicitly deferred with reason |

---

## 8. Explicit out of scope (tonight)

- Live Google Calendar / Gmail / Stripe / Notion OAuth (tiles + stubs only)
- Self-refine loop (v1.1)
- mcp-chrome / browser control (Phase 3)
- Multi-user / signup
- Editing `~/Desktop/STARGATE/web/*` or its `assets/*.png`

---

## 9. Environment keys (optional until their step)

```
ANTHROPIC_API_KEY
OPENAI_API_KEY
OPENAI_REALTIME_MODEL
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
```

Later: `GOOGLE_OAUTH_*`, `STRIPE_SECRET_KEY`, `NOTION_TOKEN`.

---

## 10. Acceptance (Book 1 §15 — target end of Step 8)

- Rings 60fps on mid-range phone
- Mic primary CTA on mobile
- Four PNGs wired as real assets
- Barge-in stops TTS within 150ms (when voice keys present)
- Memory tier stats on Bridge
- Operator voice only (grep out Sure / Happy to / Let me know)
- Boot skippable after first view; reduced-motion verified
- Contrast audit on readouts; PWA installs iOS + desktop
- PDF upload → Vault facts; “give me the brief” grounded in Tier-1 or Tier-2

---

## 11. Decisions locked

1. **Path A** — new Next.js PWA is the final STARGATE; Flask desktop app frozen.
2. **Location** — `~/Projects/stargate`.
3. **Sequencing** — vertical slices (full product tonight, step-gated).
4. **Visual reference** — Design Spec + Dashboard Enhancement Standalone.html; implement in React, do not port legacy JS wholesale.
