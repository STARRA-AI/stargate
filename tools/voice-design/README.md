# STARRA Voice Design Kit — Qwen3-TTS VoiceDesign

Designs her voice from a text description on a Colab GPU, lets Classic
iterate the description until she sounds right, and exports 48kHz WAV clips
he can bring back to this Mac.

**HARD ETHICS RULE.** This kit only does *voice design* — a voice synthesized
from a natural-language description (Qwen3-TTS's `generate_voice_design()`,
no reference audio). It never loads a clip of a real person's voice and never
touches Qwen3-TTS's voice-cloning path (`-CustomVoice`, `ref_audio`/`ref_text`).
Do not add a clone-from-audio cell to the notebook.

Why this exists: Classic's Mac is a 2-core Intel machine with no GPU — it
cannot run Qwen3-TTS-1.7B live at a usable speed. The notebook runs on his
Colab Pro GPU instead; this is a one-time (or occasional) design pass, not a
live runtime path.

## How to run

1. **Open the notebook in Colab.** Colab → File → Upload notebook → pick
   `qwen3_tts_voice_design.ipynb` (or upload it to Google Drive first and
   open it from there — either works).
2. **Runtime → Change runtime type → Hardware accelerator → GPU.** The free
   tier's T4 is enough for this model; Colab Pro can assign a better GPU if
   one is offered, but isn't required.
3. **Run cells top to bottom** (or Runtime → Run all). The first cell fails
   fast with a fix-it message if the runtime is CPU-only.
4. **Section 3 (Voice description):** the pre-filled `VOICE_DESCRIPTION` is
   written as voice quality — timbre, pitch register, pace, warmth, accent —
   not ethnicity labels, aimed at: early-20s woman, blended/mixed vocal
   timbre, British accent, warm Millennial delivery. Three alternative
   phrasings (`ALT_DESCRIPTIONS`) are included to iterate from.
5. **Section 4 (Iterate):** type a line into `TEST_LINE`, run the cell,
   listen inline. Edit the description and re-run as many times as it takes.
6. **Section 6 (Export):** run it once you're happy. It writes a ~30s neutral
   reference read plus one clip per signature line, all at 48kHz, zips them,
   and triggers a browser download. If the download doesn't start, check
   Colab's "allow downloads from this site" prompt in the browser.

## What's in the downloaded zip

| File | Content | Source |
|---|---|---|
| `00_reference.wav` | ~30s neutral read | written in the notebook for this purpose |
| `01_boot_greeting.wav` | "Evening, Classic." | `DEFAULT_BOOT_GREETING`, `src/lib/voice/deck-prefs.ts:26` |
| `02_operator_ack.wav` | "Copy." | repo `CLAUDE.md`: "Operator voice: 'Copy.' not 'Sure!'" |
| `03_call_opening.wav` | representative call-opening line | matches her persona (`src/lib/persona.ts`); see note below — this is a stand-in, not a literal quoted string |
| `04_ringback_line.wav` | short spoken ringback tease | pairs with/could replace the current ringback |

Note on `03_call_opening.wav`: there is no single fixed call-opening string
in the codebase to extract. Real call openings are generated live by the
brain per call — `src/lib/voice/useVoiceCall.ts:1710-1712` hands it the stage
direction `"[The voice call just connected — greet him, in character, one or
two short spoken sentences.]"` and the model writes something new each time.
The exported clip is a representative line in her documented voice
(`src/lib/persona.ts` IDENTITY/PRESENCE blocks), useful for judging the
*sound*, not a script she actually reads verbatim.

## Where files land in the repo

- **`data/voice-design/reference.wav`** — drop `00_reference.wav` here
  (rename it). `data/` is fully gitignored (`.gitignore:68`, `/data/`), so
  this file never gets committed — correct for privacy, since it's a clip of
  a voice built for this house specifically.
- **`public/avatar/voice/`** — new folder, doesn't exist yet. Drop the
  signature clips here if you want to keep them around as reference/audition
  files, e.g. `public/avatar/voice/boot-greeting.wav`,
  `operator-ack.wav`, `call-opening.wav`.

## What consumes them NOW vs LATER

### NOW

**Only the ringback line is a true drop-in replacement of a real static
asset.** `public/avatar/starra-ringback.mp3` is played by an `<audio>` tag in
`src/components/bridge/VoiceCallOverlay.tsx:463`
(`src="/avatar/starra-ringback.mp3"`) while the call is connecting, and today
it's an instrumental clip ("her song," per the comment above that line) —
not speech. Swapping in a spoken line changes that behavior; that's a call
for Classic to make after listening, not something this task wires up.

To convert: the model exports WAV, but the deck expects the exact filename
`starra-ringback.mp3`.

**Verified on this machine:** macOS's built-in `afconvert` does **not**
encode mp3 — `afconvert -f MPG3 -d '.mp3' in.wav out.mp3` fails with
`Error: ExtAudioFileSetProperty ('cfmt') failed ('fmt?')`. Apple's system
audio tools decode mp3 but have never shipped an mp3 *encoder* (licensing
history), so afconvert cannot do this conversion — that's a correction to
the original assumption that afconvert would work here.

Use `ffmpeg` instead — it's already installed on this machine (verified:
`/usr/local/bin/ffmpeg`, Homebrew, free/open-source, `libmp3lame` encoder
confirmed present and working):

```bash
ffmpeg -i 04_ringback_line.wav -codec:a libmp3lame -b:a 192k starra-ringback.mp3
```

Back up the original first if you want to keep the instrumental version, then
copy the result over `public/avatar/starra-ringback.mp3`.

**The boot greeting, operator ack, and call-opening clips (01-03) are NOT
drop-in file swaps today.** Verified in source: the boot greeting is
synthesized live at runtime by `speakStarra()`
(`src/lib/stargate-context.tsx:377-378`) through the deck's current TTS
engine (Eve/xAI, per repo `CLAUDE.md`) — it is never played from a static
audio file. The same TTS path is what would speak "Copy." or any spoken
call-opening line. There is no static-audio-cache feature in the deck today
for these lines. Treat `01-03` as **audition clips**: the fastest way to hear
whether this designed voice actually sounds right saying real deck lines,
before anyone considers wiring changes. If a static-audio-greeting feature
ever gets built, these are ready to drop in by filename the same way the
ringback is — that's a future task, not this one.

### LATER

A live, fully cloned/synthesized STARRA voice — replacing Eve/xAI for actual
runtime speech, not just this offline design pass — needs real GPU hardware
to run Qwen3-TTS (or a comparable model) continuously. Classic's Mac (2-core
Intel, no GPU) cannot do that; it would need rented/cloud GPU time or future
hardware. That's a spend decision that's his to make when STARGATE is
generating revenue — not something to build now.

`data/voice-design/reference.wav` is the seed for that day: a clean 48kHz
sample of the exact designed voice, ready to feed into Qwen3-TTS's own
reference-audio path (`-CustomVoice` / cloning, `ref_audio` + `ref_text`) or
any comparable voice-cloning pipeline later, without redoing the voice-design
iteration from scratch.

## Scope of this task

No wiring or code changes were made anywhere in the deck. This README and
`qwen3_tts_voice_design.ipynb` are the only two files this task adds.
