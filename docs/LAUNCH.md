# Launch STARRA

## Like a normal Mac app

```bash
cd /Users/work/Projects/stargate
npm run starra:app
```

Then:

1. Open **Finder**
2. Press **Cmd + Shift + A** (Applications)
3. Double-click **STARRA** (purple star + HUD ring icon)

Or press **Cmd + Space**, type **STARRA**, Enter.

That starts Ollama + the deck and opens the HUD in your browser.

## Terminal (same thing)

```bash
npm run starra
```

| Command | What it does |
|---------|----------------|
| `npm run starra` / `starra` | Up + open browser |
| `npm run starra:stop` | Stop the deck |
| `npm run starra:status` | Health + iPhone URL |
| `npm run starra:app` | Reinstall STARRA.app + icon |

## Wake her (HUD open)

1. Allow microphone when asked.
2. Say **“starra”**, or press **Option + Space**, or tap the badge (phone).
3. Desktop eye camera: click **EYE CAM** under the reactor (permission required).

Settings → Deck → Wake word ON/OFF.

## iPhone (same Wi‑Fi)

1. On the Mac: leave STARRA running.
2. On the phone, open the URL from `npm run starra:status`  
   (example: `http://192.168.1.65:3000`).
3. Share → **Add to Home Screen**.

## Speed (8GB Mac)

- ECO mode defaults **ON** (pauses heavy animation; click ECO in the topbar to turn off).
- Chat replies are capped short for snappier local Ollama.
- Close Chrome tabs / other apps if she feels slow — RAM is the bottleneck.
