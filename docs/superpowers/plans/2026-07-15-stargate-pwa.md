# STARGATE PWA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the final STARGATE personal-ops PWA at `~/Projects/stargate` — Bridge HUD, streaming brain, Tier-1 + memory + Vault/Brief/Pipeline, voice loop, connectors/settings stubs, installable PWA.

**Architecture:** Next.js 15 App Router + TypeScript + Tailwind v4. Server-side Claude SSE for chat; OpenAI Realtime for voice (stub without keys). Supabase when configured; local JSON store otherwise. Vertical slices Steps 0–8.

**Tech Stack:** Next.js 15, React 19, Tailwind v4, Zod, Anthropic SDK, OpenAI SDK (Realtime), `@ducanh2912/next-pwa` or Serwist, optional `@supabase/supabase-js`.

**Execution mode:** Inline in this session (operator is non-coder; do not stop for confirmation between tasks). Commit only if operator explicitly asks.

## Global Constraints

- Dark-only. CSS vars: `--void #0a0414`, `--void-2 #140826`, `--chrome #e9d5ff`, `--purple #a855f7`, `--magenta #d946ef`, `--star #c4b5fd`, `--danger #ff3d81`, `--ok #8b5cf6`.
- Fonts: Orbitron (HUD), Rajdhani (panels), JetBrains Mono (logs), Inter (Vault reader only).
- Operator voice only — never "Sure", "Happy to", "Let me know", emoji in UI copy.
- No shadcn defaults, no chat bubbles, no signup page, no light mode.
- Never modify `~/Desktop/STARGATE/web/*` or its assets.
- Four PNGs from Dashboard Enhancement → `/public/brand/`.
- Secrets server-only. Degrade gracefully when keys missing.
- Canon: design at `docs/superpowers/specs/2026-07-15-stargate-pwa-design.md`; copy unified/spec/brain into repo during Task 0.

## File map (target)

```
stargate/
  STARRA_STARGATE_UNIFIED.md
  STARGATE_DESIGN_SPEC.md
  STARRA_BRAIN.md
  docs/canon/STARRA_Master_Document_v3.pdf
  .cursorrules
  .env.example
  public/brand/{wordmark,hud_ring,hud_panel,badge}.png
  public/manifest.webmanifest
  src/app/layout.tsx
  src/app/page.tsx                    # Bridge
  src/app/brief|pipeline|memory|vault|connectors|settings/page.tsx
  src/app/globals.css
  src/app/api/chat/route.ts
  src/app/api/realtime/route.ts
  src/app/api/vault/upload/route.ts
  src/app/api/context/route.ts
  src/components/bridge/{ChromeFrame,ReactorCore,Starfield,Console,SnapPanel,ActionLog,ConnectorsTile,BootSequence,MobileHud}.tsx
  src/components/hud/{StatusLine,Panel,Readout}.tsx
  src/lib/tokens.ts
  src/lib/copy.ts
  src/lib/brain.ts
  src/lib/memory/{store,tiers,prompt}.ts
  src/lib/context/tier1.ts
  src/lib/vault/store.ts
  src/lib/state/hud-machine.ts
  src/lib/voice/{realtime,vad}.ts
  data/                 # local JSON fallback (gitignored contents ok; keep .gitkeep)
```

---

### Task 0: Bootstrap repo

**Files:**
- Create: package via `create-next-app`, `.cursorrules`, `.env.example`, canon copies, `/public/brand/*`
- Modify: none yet beyond scaffold

**Interfaces:**
- Produces: runnable `npm run dev`, brand assets at `/brand/*.png`, `STARRA_BRAIN.md` at repo root

- [ ] **Step 1: Scaffold Next.js 15**

```bash
cd /Users/work/Projects/stargate
npx create-next-app@15 . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --turbopack --yes
```

Expected: `package.json`, `src/app`, Tailwind present. If directory not empty, use `--force` or scaffold into temp and merge.

- [ ] **Step 2: Copy canon + brand assets**

```bash
cp "/Users/work/Downloads/STARRA_STARGATE_UNIFIED.md" ./STARRA_STARGATE_UNIFIED.md
cp "/Users/work/Downloads/STARGATE_DESIGN_SPEC.md" ./STARGATE_DESIGN_SPEC.md
cp "/Users/work/Downloads/STARRA_BRAIN (2).md" ./STARRA_BRAIN.md
mkdir -p docs/canon public/brand data
cp "/Users/work/Desktop/STARRA_Master_Document_v3.pdf" ./docs/canon/STARRA_Master_Document_v3.pdf
cp "/Users/work/Downloads/STARRA Dashboard Enhancement/assets/"*.png ./public/brand/
```

- [ ] **Step 3: Write `.cursorrules` (verbatim from unified Hand-off Kit)**

```
You are building STARGATE, defined in STARRA_STARGATE_UNIFIED.md at the repo root.
Always ground answers in that file. Never invent brand tone, colors, or copy —
pull them from Book 1 (Design Spec). Never invent business facts, vendors, or
numbers — pull them from Book 2 (Master Doc). Runtime system prompt = Book 3.

Hard rules:
- Dark-only. Colors are CSS vars --void, --chrome, --purple, --magenta. No shadcn defaults.
- Operator voice: "Copy." not "Sure!". No emojis in UI copy.
- Mobile is voice-first, badge is hero. Desktop is command deck.
- No chatbot bubbles. Responses stream into the console readout.
- Every feature must trace to a section in the unified doc. If it doesn't, ask.
```

- [ ] **Step 4: Write `.env.example`**

```
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
```

- [ ] **Step 5: Verify**

```bash
ls public/brand && test -f STARRA_BRAIN.md && npm run build
```

Expected: four PNGs listed; build succeeds (default page OK).

---

### Task 1: HUD shell (Bridge)

**Files:**
- Create: `src/app/globals.css`, bridge components listed in file map, `src/lib/copy.ts`, `src/lib/tokens.ts`, `src/lib/state/hud-machine.ts`
- Modify: `src/app/layout.tsx`, `src/app/page.tsx`

**Interfaces:**
- Produces: `HudState` union: `idle|wake|listening|transcribing|thinking|streaming|speaking|tool|error|offline`
- Produces: `COPY` map for boot/idle/listening/etc. from Design Spec §10
- Consumes: `/brand/*.png`

- [ ] **Step 1: Install fonts via `next/font/google`** — Orbitron, Rajdhani, JetBrains_Mono, Inter in `layout.tsx`; set CSS variables.

- [ ] **Step 2: Define tokens + copy in `src/lib/tokens.ts` and `src/lib/copy.ts`** — exact hexes and status strings from Design Spec (§3, §10).

- [ ] **Step 3: Implement `globals.css`** — void background, etched panel chrome (border + inset highlight, no drop-shadow cards), keyframes for ring-cw (40s), ring-ccw (18s), badge-breathe (3s), badge-strobe (0.6s), starfield drift; `@media (prefers-reduced-motion: reduce)` freezes rings and starfield.

- [ ] **Step 4: Build Bridge composition**
  - Desktop: ChromeFrame (hud_panel 9-slice or border-image), left Snap+Memory, center ReactorCore (layered hud_ring spins + badge), right ActionLog+Connectors, bottom Console shell (mic/input/send UI wired later).
  - Mobile: compact bar, large badge mic, last reply strip, tab strip.
  - BootSequence on first load (sessionStorage skip after first).

- [ ] **Step 5: Verify visually**

```bash
npm run dev
```

Open `http://localhost:3000` — rings animate, wordmark ≥120px, no white/light theme, mobile layout at <768.

---

### Task 2: Console + streaming chat

**Files:**
- Create: `src/lib/brain.ts`, `src/app/api/chat/route.ts`, wire Console on Bridge
- Modify: Console component, `page.tsx`

**Interfaces:**
- `buildSystemPrompt(): string` — STARRA_BRAIN.md (truncate 8K) + operator voice rules
- `POST /api/chat` body `{ messages: {role,content}[] }` → `text/event-stream` tokens
- Without `ANTHROPIC_API_KEY`: stream a canned operator-voice offline line

- [ ] **Step 1: `src/lib/brain.ts`** — `fs.readFileSync` of `STARRA_BRAIN.md` (server-only); append anti-assistant rules.

- [ ] **Step 2: `api/chat/route.ts`** — Anthropic Messages API streaming; map to SSE `data: {"text":"..."}\n\n`; end with `data: [DONE]`.

- [ ] **Step 3: Console client** — send on Enter/send; glyph reveal ~30ms/char (skip if reduced-motion); no bubbles; append to action log.

- [ ] **Step 4: Verify** — with and without API key; grep UI strings for forbidden phrases.

---

### Task 3: Tier-1 typed context

**Files:**
- Create: `src/lib/context/tier1.ts`, `data/tier1.json` seed, `src/app/api/context/route.ts`
- Modify: SnapPanel, chat prompt builder

**Interfaces:**
- Types: `Goal`, `Project`, `Task`, `Decision` with zod schemas
- `getTier1()` / `saveTier1()` — local file under `data/` or Supabase table `tier1` if env set
- Prompt includes serialized Tier-1 snapshot

- [ ] Seed with STARRA-relevant stub (Plus Ultra goals, credit Day-1 tasks) — clearly labeled sample until operator edits.
- [ ] Bridge BUSINESS SNAP reads live counts (tasks due, pipeline open).
- [ ] Minimal edit UI on Settings or inline Snap “EDIT CONTEXT” panel (operator voice labels).

---

### Task 4: Memory tiers

**Files:**
- Create: `src/lib/memory/{store,tiers,prompt}.ts`
- Modify: chat route, Memory page, Bridge memory readouts

**Interfaces:**
- Working: last 10 exchanges
- Summary: compress every 30 msgs to a paragraph (LLM if key else concatenate truncate)
- Archival: embed if OpenAI key else keyword search; top-k into prompt
- Bridge shows counts: working / summary / archival

---

### Task 5: Vault + Brief + Pipeline

**Files:**
- Create: vault store + upload API, pages for vault/brief/pipeline
- Modify: nav from Bridge

**Interfaces:**
- `POST /api/vault/upload` multipart → store file + extract text (pdf-parse / mammoth / raw text) → facts array
- Brief page composes from Tier-1 + recent memory + vault facts via `/api/chat` or dedicated brief builder
- Pipeline: local cards `{id,title,stage,nextStep}`; stages triage/active/blocked/won

---

### Task 6: Voice loop

**Files:**
- Create: `src/lib/voice/realtime.ts`, `src/lib/voice/vad.ts`, `src/app/api/realtime/route.ts`
- Modify: ReactorCore badge, Console mic, hud-machine

**Interfaces:**
- `GET/POST /api/realtime` issues ephemeral client secret when `OPENAI_API_KEY` set; else `{ mode: "stub" }`
- Barge-in: on speech detection while speaking, `audioContext` stop + cancel TTS within 150ms target
- Desktop wake: Alt/Option+Space; mobile: tap badge
- Without keys: Web Speech API fallback or text-only with status `VOICE LINK UNAVAILABLE`

---

### Task 7: Connectors + Settings

**Files:**
- Create: connectors + settings pages, `data/connectors.json`
- Modify: Bridge ConnectorsTile

**Interfaces:**
- Connector status enum: `connected | available | error`
- Settings: wake key display, voice intensity slider, theme intensity slider, model label
- No real OAuth unless env credentials present; tiles stay `○ available`

---

### Task 8: PWA + acceptance gate

**Files:**
- Create: `public/manifest.webmanifest`, icons from badge, service worker via next-pwa/serwist
- Modify: `layout.tsx` metadata, offline fallback caching last brief/memory in Cache Storage / localStorage

**Verify (manual checklist writeup in `docs/ACCEPTANCE.md`):**
- Installable, dark, four PNGs, operator copy grep clean, reduced-motion, offline read path
- Note deferred items (live OAuth, barge-in without keys) explicitly

---

## Self-review notes

- Spec coverage: Steps 0–8 map 1:1 to design §7; out-of-scope §8 honored.
- No live OAuth / self-refine / mcp-chrome in tasks.
- Types named consistently: `HudState`, `Tier1Data`, `MemoryTiers`, `VaultDoc`.
