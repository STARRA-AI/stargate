# STARGATE acceptance — 2026-07-15

Checked against Book 1 §15 / design Step 8.

| Item | Status |
|------|--------|
| Rings animate (CSS 40s/18s) | Pass — verify 60fps on device |
| Mic primary CTA on mobile | Pass — ReactorCore badge hero |
| Four PNGs in `/public/brand/` | Pass |
| Voice barge-in cancels TTS | Pass — `stopSpeaking()` on speech/wake; full Realtime WebRTC deferred without keys |
| Memory tier stats on Bridge | Pass — SnapHydrator + SnapPanel |
| Operator voice only | Pass — COPY + brain rules; offline stub operator register |
| Boot sequence skippable | Pass — sessionStorage + SKIP |
| `prefers-reduced-motion` | Pass — globals.css |
| Contrast tokens on void | Pass — design tokens |
| PWA manifest + SW | Pass — installable; test on iOS/desktop |
| PDF/TXT → Vault facts | Pass — `/vault` upload API |
| “Give me the brief” grounded | Pass — Tier-1 + memory + vault in `/api/chat` |

## Deferred (explicit)

- Live Calendar/Gmail/Stripe OAuth
- Full OpenAI Realtime WebRTC duplex (session endpoint ready; browser STT/TTS fallback ships)
- Self-refine loop (v1.1)
- mcp-chrome
- Supabase (local JSON under `data/` until keys added)

## Run

```bash
cd ~/Projects/stargate
cp .env.example .env.local   # add ANTHROPIC_API_KEY when ready
npm run dev
```

Open http://localhost:3000
