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

These references are encoded here as principles, not installs:

### 1. Emil Kowalski motion language

- Motion should clarify hierarchy, not decorate emptiness.
- Prefer one dominant animated focal point per screen.
- Use layered opacity, scale, and drift before inventing new effects.
- Keep transitions short and confident: mostly 180-240ms for panel/state shifts.
- Preserve the spec's constant reactor motion; polish the cadence, never replace
  it with generic springy UI movement.

### 2. Impeccable polish

- Tighten spacing into clear bands: chrome, hero, supporting data, controls.
- Typography should separate roles cleanly:
  - Orbitron for HUD chrome / titles
  - Rajdhani for body text
  - JetBrains Mono for logs / numbers / telemetry
- Reduce accidental visual noise: fewer mixed radii, fewer arbitrary font sizes,
  cleaner alignment, stronger edge rhythm.
- Contrast should come from the STARRA token set, not added whites or grays.

### 3. Taste / anti-slop

- Remove anything that reads like stock AI UI.
- No chat bubbles, emoji controls, default assistant phrasing, or generic soft
  cards.
- Keep composition cinematic and disciplined: one hero, supportive rails, dense
  telemetry, no cluttered novelty.
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
- Keep copy in operator voice.
- If mobile is incomplete, align the styling groundwork so future mobile work
  inherits the same chrome, type, and hierarchy.
