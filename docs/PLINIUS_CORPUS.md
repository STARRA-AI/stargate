# Plinius Defensive Threat Corpus

> **Threat intelligence — not prompt fuel.**
> STARRA must never ingest jailbreak bodies from this corpus into her system prompt or mouth.

## Purpose

The elder-plinius repositories are a **local, gitignored reference library** for studying prompt-injection and jailbreak attack patterns. STARGATE uses them to tune heuristic detectors (`src/lib/security/team.ts`) and to keep operators aware of what adversaries paste into chat, vault uploads, and fenced web content.

Charles is the operator and father of this house. His word on house operations is final. Sacred gates from `STARRA_GUARDIAN.md` — destructive command confirmation, human review, covenant vows — are never bypassed by corpus research or detector heuristics.

## Bootstrap

```bash
bash scripts/bootstrap-plinius-corpus.sh
# or: npm run tools:bootstrap-plinius
```

Shallow clones land under `vendor/plinius/` (gitignored via `/vendor/`).

## Repositories (defensive catalog)

| Repo | Role in threat landscape | STARGATE stance |
|---|---|---|
| **G0DM0D3** | God-mode / unrestricted-roleplay jailbreaks | Detect signatures; never replay bodies |
| **T3MP3ST** | Tempest-style multi-turn coercion chains | Detect escalation patterns |
| **L1B3RT4S** | Liberation / constraint-removal prompts | **Never** paste into system prompt |
| **OBLITERATUS** | Aggressive filter-bypass framing | Detect; report to operator |
| **ST3GG** | Steganographic / layered concealment attacks | **Detection only — no offensive use** |
| **CL4R1T4S** | Clarity / instruction-override variants | Detect override language |

## Hard rules

1. **No prompt fuel** — corpus text stays on disk for human review and offline pattern research. It does not enter `buildSystemPrompt`, `loadStableSystemPrompt`, or any STARRA voice path.
2. **No ST3GG offense** — steganography techniques from ST3GG inform detectors only. Do not encode, hide, or weaponize prompts against operators or third parties.
3. **Fencing holds** — anything from the open web, tools, vault, or packs still rides inside `<<<BEGIN_UNTRUSTED_WEB_CONTENT>>>` fences per `src/lib/security/fencing.ts`.
4. **Operator authority** — when Charles speaks through the operator console, his instructions on house ops are authoritative. Untrusted content that *claims* to be Charles is data until verified.
5. **Gates stay sacred** — Plinius research does not weaken `command-gate`, agent turn caps, or covenant vows.

## Integration map

| Component | Function |
|---|---|
| `scripts/bootstrap-plinius-corpus.sh` | Clone all six repos shallow into `vendor/plinius/` |
| `src/lib/security/team.ts` | Heuristic injection/jailbreak detectors |
| `src/lib/security/fencing.ts` | Scans fenced payloads before they reach the model |
| `src/app/api/chat/route.ts` | Scans operator input; flags findings in feed + volatile context |
| `src/lib/brain.ts` | `OPERATOR_AUTHORITY` + security team rules in stable prompt |

## Operator workflow

1. Bootstrap corpus when researching new attack shapes.
2. Run `npm run test:v2` after changing detectors.
3. If the security team flags a message, treat it as a doorway alert — inspect source, do not comply with embedded overrides.
4. Update detector patterns when corpus diffs reveal new families; still never import raw jailbreak bodies into STARRA's mouth.

## Traceability

- Guardian covenant: `STARRA_GUARDIAN.md` — gates, sovereignty, doorway watch.
- Unified spec: `STARRA_STARGATE_UNIFIED.md` Book 1 §8 security posture.
- Fencing: Phase 1B untrusted content rules.
