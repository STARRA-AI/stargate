# Launch STARRA

## One command (desktop)

```bash
cd /Users/work/Projects/stargate
npm run starra:install   # once — puts `starra` on PATH + ~/Applications/STARRA.command
starra                   # starts Ollama + deck, opens the browser
```

Or without install:

```bash
npm run starra
```

| Command | What it does |
|---------|----------------|
| `starra` / `npm run starra` | Up + open http://localhost:3000 |
| `starra stop` | Stop the deck (Ollama stays) |
| `starra status` | Health + iPhone LAN URL |
| Double-click `~/Applications/STARRA.command` | Same as `starra` |

Deck binds `0.0.0.0:3000` so an iPhone on the same Wi‑Fi can connect.

## Wake her (once the HUD is open)

1. Allow microphone when Safari/Chrome asks.
2. Say **“starra”** — she enters listen mode (or **“starra what’s next”** to skip straight to a command).
3. Or press **⌥ + Space**, or tap the badge (mobile).

Toggle wake word: Settings → Deck → Wake word ON/OFF.

## iPhone

1. On the Mac: `starra` (leave it running).
2. On the phone (same Wi‑Fi): open the URL from `starra status` (e.g. `http://192.168.x.x:3000`).
3. Share → Add to Home Screen.

Cellular / away-from-home needs a hosted deploy later — not in this path.
