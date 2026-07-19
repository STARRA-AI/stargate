# Spec A — Front-facing UI cleanup + Grok-style chat

Date: 2026-07-19 · Status: approved (design), pre-implementation
Part of the STARGATE upgrade program (Specs A→B→C→D). This is Spec A.

## Context

STARGATE's chat is a single terminal readout (`DeckConsole.tsx`): `YOU`/`STARRA`
labels inline, a chip row, and a `MIC | input | SEND` bar. It works but reads as
a scaffold. The operator wants the chat + call surfaces to feel like Grok's —
clean message column, modern composer — and a front-facing cleanup pass, all
**without changing STARGATE's galaxy/purple identity or operator voice**.

Decision made during brainstorming: adopt a **full Grok-style message column**.
This overrides the legacy repo rule "no chatbot bubbles" — `CLAUDE.md` will be
updated to match. All STARGATE tokens, fonts, and the operator register stay.

## Goals
1. Redesign the desktop chat into a Grok-style conversation + composer.
2. Bring the mobile chat surface to parity.
3. A front-facing cleanup pass (form + function, consistent tokens) guided by the
   `starra-design` doctrine (`.claude/skills/starra-design`).
4. A visual shell for the `/call` page (behavior lands in Spec C).

Explicitly out of scope: backend/provider changes, the voice feature-pack (B),
call behavior (C), trading (D).

## Design

**Message column (`DeckConsole` conversation area)**
- Centered, width-constrained column with vertical rhythm bands.
- User turn: right-aligned rounded container, `--void-2` fill + thin `--border`.
- Assistant turn: left-aligned, no bubble, `--chrome` text, **markdown-rendered**
  (headings, lists, bold, inline code, fenced code in JetBrains Mono).
- Streaming: text streams with a blinking `--magenta` caret; entry animation
  150–300ms per the design doctrine; respects `prefers-reduced-motion`.
- Keep the existing `/api/chat` SSE wiring and `revealText`/TTS flow untouched —
  this is a presentation-layer change.

**Composer (replaces `chat-input-row`)**
- Pill-shaped bar: mic button + auto-growing `textarea` (Enter=send, Shift+Enter=
  newline) + send button; `--purple` focus ring; chip row folded in above it.
- Preserve current handlers (`send`, `onMic`), abort-in-flight behavior.

**Mobile parity**
- Same message-column + composer treatment on the mobile voice-first surface;
  badge stays hero (per doctrine). No behavior change.

**Cleanup pass**
- Normalize spacing/typography/token usage across Bridge, console, settings —
  Orbitron chrome / Rajdhani body / JetBrains Mono telemetry; consistent radii;
  contrast from the token set only. No new aesthetic, no unrelated refactors.

**Call surface shell**
- Static visual container for `/call` (orb state, transcript pane placeholder,
  in-call composer) — styled, not wired. Spec C fills behavior.

## Components / boundaries
- `DeckConsole.tsx` — split presentation: `MessageColumn`, `MessageTurn`,
  `Composer`, and a small `markdown` render util (new, dependency-light or a
  vetted lib). Chat/network logic stays in `DeckConsole`.
- `deck.css` — new message-column + composer styles; retire terminal chat styles.
- Mobile chat component(s) in `Bridge.tsx` — mirror the treatment.
- `CLAUDE.md` — update the "no bubbles" rule.

## Task decomposition (the /loop)
1. **chat-core** — message column + turns + markdown + streaming caret + composer in `DeckConsole`/`deck.css`; update `CLAUDE.md`. (foundation; touches shared files)
2. **mobile-parity** — apply the treatment to the mobile surface. (after 1)
3. **cleanup-pass** — token/spacing/type normalization across front-facing surfaces. (after 1)
4. **call-shell** — static `/call` visual container. (parallel-safe; new files)

Each task → one Opus agent → reports to Fable → review against this spec +
`starra-design` + typecheck/lint → fix or approve → integrate. Loop until Spec A
is complete, organized, debugged, and verified.

## Verification
- Typecheck (`tsc --noEmit`) + lint clean on every task.
- Visual check of the chat (desktop + mobile): Grok-style turns, working composer
  (Enter/Shift+Enter), markdown + code rendering, streaming caret, reduced-motion.
- `/api/chat` still streams and speaks (Ara/Piper) unchanged.
- Aesthetic unchanged: same tokens/fonts; reactor eye + galaxy identity intact.
