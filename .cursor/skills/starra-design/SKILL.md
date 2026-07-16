---
name: starra-design
description: Apply STARRA's repo-local visual doctrine when polishing the Bridge, mobile HUD, or adjacent product surfaces.
---

# STARRA Design Doctrine

Use this skill whenever changing STARGATE's look, layout, motion, spacing,
typography, or microcopy.

## Source of truth

Always ground decisions in:

1. `STARRA_STARGATE_UNIFIED.md` Book 1
2. `.cursorrules`
3. `docs/STARRA_CONFERENCE.md` for known design drift and current priorities

This skill exists so STARRA keeps her own design language inside the repo
instead of depending on external packages or third-party prompt repos.

## External reference mapping

These references are encoded here as principles, not installs. If a local Emil
skill clone exists elsewhere, use it as source material, but keep the doctrine
repo-owned here.

### 1. `animation-vocabulary`

- Treat motion as a small set of reusable verbs: rotate, drift, breathe,
  reveal, pulse, slide, brighten, dim.
- Pick the smallest verb that explains the state change. Do not stack multiple
  flashy effects when one transform or opacity change will do.
- Prefer transform + opacity first. Avoid layout-thrashing animation.
- Match the motion verb to the UI role:
  - reactor / badge = breathe, pulse, rotate
  - panels = slide, reveal
  - logs / console text = reveal
  - status chrome = brighten, dim
- Keep a clear resting state. STARGATE should feel alive, not busy.

### 2. `apple-design`

- Borrow iOS feel through restraint, legibility, and touch comfort, not through
  light-mode Apple mimicry.
- Mobile surfaces should feel precise and hardware-adjacent:
  - strong center hero
  - clean safe-area spacing
  - obvious touch targets
  - crisp material layering
  - minimal copy per block
- Use glass/chrome sparingly: subtle blur, thin borders, controlled glow. Never
  let blur overpower HUD readability.
- Favor direct manipulation cues on phone: the badge should read as the obvious
  action anchor and tabs should feel tap-ready at a glance.
- Keep radii and spacing disciplined. Apple-like polish here means consistency,
  not softness.
- Preserve STARGATE's dark reactor identity. Do not import white cards, pastel
  gradients, bouncy springs, or generic iOS settings-screen patterns.

### 3. `find-animation-opportunities`

- Audit only meaningful state changes:
  - boot
  - wake / listen / think / speak
  - panel selection
  - feed arrival
  - proposal attention
  - connector status change
- Add motion only where it improves orientation, hierarchy, or responsiveness.
- Good candidates:
  - active tab emphasis
  - console/live-feed entry
  - badge response when voice becomes active
  - subtle elevation/brightening on primary actions
- Bad candidates:
  - looping motion on every rail
  - decorative hover noise
  - bouncing controls
  - animation on dense telemetry that should stay stable

### 4. `improve-animations`

- Reduce competing motion before adding new motion.
- Tune durations to the Book 1 cadence:
  - panel/state shifts: 180-240ms
  - badge breathe: around 3s
  - listening/speaking pulse: faster, but still readable
  - ring rotation: preserve Book 1's long loops
- Ease should feel decisive and controlled. Prefer ease-out or smooth custom
  curves over playful springiness.
- If an effect draws attention away from the badge or obscures readouts, weaken
  or remove it.
- Re-check reduced-motion behavior every time motion changes.

### 5. `review-animations`

- Review screens by asking:
  - What is the single animated focal point?
  - Does motion explain state, or just prove CSS exists?
  - Are there any two elements competing for attention?
  - Does the idle state still feel calm?
  - Is mobile thumb use clearer after the motion, not just prettier?
- Fail the review if:
  - motion looks like generic AI app flourish
  - the badge is not the visual leader on phone
  - panel transitions feel mushy or bounce-heavy
  - reduced-motion path loses hierarchy or clarity
  - console/feed motion makes reading harder

### 6. Taste / anti-slop

- Remove anything that reads like stock AI UI.
- No chat bubbles, emoji controls, default assistant phrasing, or generic soft
  cards.
- Keep composition cinematic and disciplined: one hero, supportive rails, dense
  telemetry, no cluttered novelty.
- Tighten spacing into clear bands: chrome, hero, supporting data, controls.
- Typography should separate roles cleanly:
  - Orbitron for HUD chrome / titles
  - Rajdhani for body text
  - JetBrains Mono for logs / numbers / telemetry
- Reduce accidental visual noise: fewer mixed radii, fewer arbitrary font sizes,
  cleaner alignment, stronger edge rhythm.
- Contrast should come from the STARRA token set, not added whites or grays.
- When in doubt, subtract before adding.

## STARRA-specific composition rules

- Dark only. Use `--void`, `--void-2`, `--chrome`, `--purple`, `--magenta`,
  `--star`, `--danger`, `--ok`.
- Desktop remains the command deck.
- Mobile remains voice-first, badge hero.
- The badge is the primary CTA on phone and a visual state anchor on desktop.
- Responses stream into the console readout, never bubbles.
- Motion must respect `prefers-reduced-motion`.

## Practical application checklist

- Confirm the page still feels like STARGATE, not a new product.
- Check the main hero dominance first, then secondary rails, then controls.
- Normalize fonts to their intended roles.
- Improve spacing and contrast before adding any new ornament.
- On mobile, verify the badge remains the thumb-first primary action.
- On desktop, verify the reactor still dominates over side-panel motion.
- If adding motion, name the verb you are using and ensure it fits the role.
- Keep copy in operator voice.
- If mobile is incomplete, align the styling groundwork so future mobile work
  inherits the same chrome, type, and hierarchy.
