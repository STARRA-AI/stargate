# OpenMontage — STARRA video production path

**Canonical.** OpenMontage (`calesthio/OpenMontage`) is STARRA's video studio for Silent Shadow Shorts and Book of Starra visuals.

**Retired.** Higgsfield is not the STARGATE video path. Do not wire `higgsfield_action.py`, do not queue jobs against Higgsfield from the HUD, and do not tell Classic that Higgsfield is required for Shorts. Historical pain (CDN, silent moderation, explainer 404s) is why we left it. Optional paid gen models may be configured *inside* OpenMontage later — never as a parallel STARGATE stack.

## What STARRA does

1. **Queue** a brief via Tools, console (`queue a short about …`), or agent tool.
2. Write the brief to `data/openmontage-briefs/<id>.md` and job row to `data/openmontage-jobs.json`.
3. **Never claim render finished** until an operator/agent marks the job done with a real output path.
4. Hand `vendor/OpenMontage/AGENT_GUIDE.md` + the brief to a coding agent for render.

## Constraints (always in briefs)

- Silent Shadow: pseudonymous; Storm Ink (indigo/charcoal/gold); 6 blocks × ~10s; Anton captions; 9:16; mandatory caption QA (known-text `.srt`, no Whisper ambient hallucination).
- Integrity: no fake scarcity; no income promises.
- Human posting gate remains: STARGATE does not auto-publish to social.

## Operator setup

```bash
npm run tools:bootstrap          # clone if missing
npm run tools:montage-setup      # optional: venv + remotion deps
```

Then Tools → OpenMontage → queue a topic, or console: `queue a short about healing after her`.

## Surfaces

| Surface | Path |
|---------|------|
| Vendor | `vendor/OpenMontage` (gitignored) |
| API | `GET/POST /api/tools/openmontage` |
| UI | Tools → OpenMontage |
| Doctrine | this file (clipped into stable prompt) |
