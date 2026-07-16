# Where STARGATE lives (simple guide)

You have **8 GB of RAM** and a **1 TB external drive** named **Storage**.

## The setup (why it’s like this)

| What | Where | Why |
|------|--------|-----|
| STARGATE app (HUD, animations, code) | Mac SSD → `~/Projects/stargate` | Fast — rings/UI stay smooth |
| AI models (Ollama) | `/Volumes/Storage/STARRA/ollama/models` | Big files off the full SSD |
| OpenMontage + uploads + packs | `/Volumes/Storage/STARRA/…` | Heavy; linked from the project |
| Offloaded zips/videos | `/Volumes/Storage/STARRA/Offloaded` | Frees the Mac without deleting |

**RAM rule:** keep using the small free model (`qwen2.5:1.5b` or `deepseek-r1:1.5b`). A bigger model will thrash even with a big hard drive.

## Every day — start STARGATE

1. Plug in / wake the **Storage** drive (Finder shows **Storage**).
2. Open **Terminal** and run:

```bash
bash ~/Projects/stargate/scripts/starra-up.sh
```

3. Open a browser to [http://localhost:3000](http://localhost:3000).

That’s it. The script checks the drive, starts Ollama, then starts the app.

## If something’s wrong

- **“Storage drive not mounted”** → reconnect the 1TB drive.
- **Bridge won’t answer** → in Terminal: `ollama serve` then try again.
- **Computer feels slow** → quit other apps; only one small Ollama model should be loaded.

## Do not delete

- Credit / dispute PDFs  
- `~/Projects/stargate` source  
- Anything under `/Volumes/Storage/STARRA` unless you know it’s a duplicate
