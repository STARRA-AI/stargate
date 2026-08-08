# PRIVATE CALL + HER VOICE — all-local call mode, speed pack, voice asset

Classic's order (2026-08-04): maximum privacy — a call mode where NOTHING
leaves the Mac (local ears, local brain, local mouth) beside the normal
Kimi/Eve call; make everything faster; and mint HER voice (20-year-old
half-Japanese half-Black woman, Millennial personality, British accent)
with Qwen3-TTS VoiceDesign — designed synthetic voice, never a clone of a
real person without consent.

Verified 2026-08-04 before this plan:
- Machine: Intel i5-6267U (2 cores, 2015), 8GB RAM, macOS 12, NO GPU.
  Qwen3-TTS (0.6B/1.7B, GPU-first, Apache-2.0, github.com/QwenLM/Qwen3-TTS
  pushed 2026-03-17) CANNOT run live here — it runs ONCE on Colab Pro
  (Classic already pays) to design the voice asset. Live local TTS on this
  CPU = Piper (installed; en_GB voices incl. Cori) — real-time capable.
- Ollama running (qwen2.5:3b + 1.5b) but models unload when idle (ollama
  ps showed none resident) — cold reload tax on every first ask.
- The orphaned llama-server that pinned a core is gone (pid 51592 no
  longer exists).
- Private lane (docs/PRIVATE_LANE.md) is live: /api/chat `private …`
  branch, loopback-gated private-gpt on :8080, client silence gates.
- whisper.cpp: NOT installed. Expected near-real-time for tiny.en/base.en
  on 2-core AVX2 — UNVERIFIED until Task 2 measures it.
- Call engine: src/lib/voice/useVoiceCall.ts (xAI realtime; kimi brain via
  turn_detection:null + client endpointer + force_message). Overlay:
  src/components/bridge/VoiceCallOverlay.tsx. Local TTS: speak.ts →
  piper-runtime.ts. Engine bus: src/lib/engine/bus.ts (callLive gate).

## Global Constraints (binding on every task)

- FREE ONLY. Colab Pro and xAI are already his; add nothing paid.
- PRIVATE MODE MEANS ZERO BYTES OFF-BOX: no xAI socket, no /api/tts, no
  Web Speech (Google STT), no hosted brain, no web-search/weather. Only
  127.0.0.1 targets (Ollama :11434, private-gpt :8080, whisper server).
  Reuse `isLoopbackBase`/`isLocalRequest` patterns; never fall back from
  private to hosted silently.
- THE NORMAL LANES ARE LOCKED and must stay byte-identical: Kimi brain,
  Eve/xAI normal call, Ara TTS for normal chat. Private call is ADDITIVE
  (a toggle), exactly like the private chat lane was.
- 2-CORE/8GB DISCIPLINE: whisper tiny.en or base.en (quantized) only;
  one LLM resident at a time; measure before claiming real-time.
- VERIFY FROM SOURCE, CITE file:line (vendor clones, Ollama docs, Piper).
- DIRTY TREE: commit only your task's files, explicit paths, never -A/-u.
- Repo idioms: node:test via tsx; tsc + eslint green per task; macOS 12
  WebKit = no regex lookbehind client-side; UI copy operator-voice, no
  emojis; dark tokens only.
- Voice ethics rule (Classic's charter): the Qwen3-TTS voice is DESIGNED
  from a text description. No cloning of any real person's voice.

## Task 1: Speed pack — resident model + measured baseline

1. Determine how Ollama is launched on this machine (launchd? login item?
   manual?) and set `OLLAMA_KEEP_ALIVE=-1` (or `24h`) so the active model
   stays resident; document where it was set and how to undo it. If the
   serve process can't be found running under a manageable launcher, add
   the env to the existing deck scripts pattern (scripts/) with a note.
2. Choose residency for the PRIVATE brain deliberately: qwen2.5:3b stays
   the lane's model (quality) — do not switch models in this task.
3. MEASURE before/after and put numbers in the report: time-to-first-token
   and total time for one short completion via private-gpt (:8080) cold
   vs warm (model resident). Also record `ollama ps` showing residency.
4. One runbook touch: docs/PRIVATE_LANE.md performance section gets the
   real numbers replacing the contention-era ones (minutes → measured).

Commit: any script/env file changed + the runbook edit.

## Task 2: Local ears — whisper.cpp service

1. `scripts/bootstrap-whisper.sh` (idempotent, pattern of
   bootstrap-private-gpt.sh): clone ggml-org/whisper.cpp into vendor/
   (gitignore it), build with make (Intel AVX2), download ggml tiny.en
   AND base.en quantized models into data/models/whisper/ (both — Task 4
   picks per measured speed).
2. `scripts/whisper-up.sh` / `whisper-down.sh` (pid file, log, port
   127.0.0.1:8178) running whisper.cpp's server example with the base.en
   model; document the exact transcription HTTP API (cite the vendor
   source file:line for the endpoint/params).
3. PROVE it: transcribe a generated test WAV (say + afconvert one line of
   spoken text via macOS `say` — it's local) end-to-end via HTTP; paste
   the transcript + timing in the report. MEASURE real-time factor for
   tiny.en vs base.en on a ~5s clip; numbers in the report.
4. .env.local: `WHISPER_BASE=http://127.0.0.1:8178` (state content in
   report, don't commit the file).

Commit: the two/three scripts + .gitignore if changed.

## Task 3: Local mouth — sentence-streaming Piper voice module

1. New pure module `src/lib/voice/local-voice.ts`: split streaming text
   into speakable sentences (pure, exported, tested — handle fences via
   speakableText, abbreviations conservatively), and a
   `speakLocalStream()` engine that synthesizes sentence N+1 with Piper
   (piper-runtime.ts) while sentence N plays, through ONE queued audio
   element chain publishing to the engine bus (`publishVoice` speaking/
   analyser, source "piper") so her face works — same bus contract as
   speak.ts. Respect stopAllSpeech()/barge-in: a stop kills queue + synth.
2. Voice selection: default Piper voice for HER = the en_GB voice closest
   to the target character; expose `STARRA_LOCAL_VOICE` env/localStorage
   override the Colab-designed asset can later inform. Do NOT change the
   normal chat TTS chain (Ara stays primary for normal turns).
3. PRIVATE DECK REPLIES GAIN HER LOCAL VOICE (upgrade from silent-text):
   in stargate-context, a private-flagged reply may speak via
   speakLocalStream ONLY (never speakStarra/Ara). The speak.ts callLive
   gate applies unchanged (no chat TTS during a live call). Update
   docs/PRIVATE_LANE.md ("silent" → "local voice only, never xAI") and
   the affected private-lane tests.
4. Tests: sentence-splitter units; source-pattern pins (private reply
   path can only reach speakLocalStream; speakLocalStream module contains
   no fetch to non-loopback hosts).

Commit: the new module, stargate-context.tsx, tests, runbook edit.

## Task 4: PRIVATE CALL — the all-local call mode

1. Toggle on the call overlay (dark-token styled, operator copy:
   "PRIVATE" / "NORMAL") choosing the engine for the NEXT connect;
   persisted in localStorage; default NORMAL. While a call is live the
   toggle is locked (no mid-call swaps in V1).
2. New hook `usePrivateCall` (own file; do NOT fork useVoiceCall's xAI
   internals): mic via getUserMedia → energy endpointer (reuse the
   exported kimiEndpointStep + thresholds from useVoiceCall) → WAV chunk
   → whisper server (WHISPER_BASE) → transcript → `/api/chat` with the
   text prefixed `private ` (rides the EXISTING private lane: loopback
   gates, no-store rules, {"private":true} frame all apply for free) →
   reply → speakLocalStream (Task 3) → face analyser from the bus.
   Transcript column + live partials mirror the normal call's UI surface
   (reuse VoiceCallOverlay rendering with the alternate engine's state).
3. Privacy proof in the report: with the private call up, enumerate every
   socket the tab/server opens (lsof against the dev server + browser
   request log) — nothing but 127.0.0.1.
4. Latency budget in the report: measured utterance→first-audio time.
   State it honestly in the toggle's status line if >5s ("PRIVATE — local
   brain, slower").
5. Barge-in: talking while she speaks stops local playback (bus stop +
   queue flush). The callLive bus claim applies to private calls too
   (publishCallLive on connect/disconnect) so chat TTS stays silenced.
6. Tests: endpointer reuse pins, source-pattern (usePrivateCall contains
   no xai/api.x.ai/wss token, no /api/tts, no Web Speech), toggle
   default-NORMAL pin.

Commit: the new hook, overlay changes, deck.css if needed, tests.

## Task 5: Voice asset kit — Qwen3-TTS VoiceDesign on Colab

1. `tools/voice-design/qwen3_tts_voice_design.ipynb`: Colab notebook —
   installs Qwen3-TTS from the official repo, loads
   Qwen3-TTS-12Hz-1.7B-VoiceDesign, takes a VOICE_DESCRIPTION cell
   (pre-filled: early-20s woman, mixed Japanese/Black heritage timbre,
   British accent, warm Millennial delivery — written as voice-quality
   description, not ethnicity checkboxes), an iteration cell (type a
   line, hear it), and an EXPORT cell producing: reference.wav (~30s
   neutral read) + signature clips from `signature_lines.txt`
   (greeting, "Copy.", call-opening, ringback line) as 48k WAVs zipped.
   GPU runtime notes + VRAM fit for 1.7B on Colab's free/Pro tiers —
   cite the repo README for install + model ids.
2. `tools/voice-design/README.md`: how Classic runs it (open in Colab,
   Runtime→GPU, run cells, iterate description until she's right,
   download zip), where to drop outputs
   (public/avatar/voice/ + data/voice-design/reference.wav), and what
   consumes them NOW (ringback/greeting clips are drop-in replaceable
   files — name the exact current asset paths from the repo) vs LATER
   (live cloned voice needs GPU hardware).
3. NO wiring changes in this task beyond documenting the drop-in paths —
   the clips replace existing static assets by filename.

Commit: notebook + README (tools/voice-design/).

## Task 6: Runbook, consistency, final review prep

1. docs/PRIVATE_LANE.md gains the PRIVATE CALL section (how to toggle,
   what's local, measured latencies, the honest limits update: spoken
   private asks are now SAFE in a PRIVATE call — local ears — while the
   NORMAL call/deck-mic warnings stand).
2. CLAUDE.md: extend the private-lane line: private CALL toggle exists;
   normal call unchanged.
3. Full suite + tsc + eslint green; consistency sweep (ports, env names,
   script names across scripts/env/runbook/CLAUDE.md).

Commit: docs, CLAUDE.md, any test consolidation.
