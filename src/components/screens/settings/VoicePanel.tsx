"use client";

import { useEffect, useState } from "react";

/**
 * VOICE PANEL — lifted verbatim out of src/app/settings/page.tsx (the former
 * BootGreetingSettings/SyncRepliesToggle/MicModeSetting/VoicePicker block).
 * These four change together and are only ever rendered together, so they live
 * together. Logic is byte-for-byte the original; only class names moved to the
 * deck primitives.
 */

/**
 * BOOT GREETING + MUTE ON BOOT (G2). Backed by Agent A's
 * `@/lib/voice/deck-prefs` (SHARED CONTRACT §2), imported dynamically the
 * same way WakeWordToggle imports wake-word.
 */
function BootGreetingSettings() {
  const [text, setText] = useState("Evening, Classic.");
  const [muted, setMuted] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void import("@/lib/voice/deck-prefs").then(
      ({ getBootGreeting, getBootGreetingMuted }) => {
        setText(getBootGreeting());
        setMuted(getBootGreetingMuted());
      },
    );
  }, []);

  async function save() {
    const { setBootGreeting } = await import("@/lib/voice/deck-prefs");
    setBootGreeting(text);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
  }

  async function toggleMuted() {
    const { setBootGreetingMuted, getBootGreetingMuted } = await import(
      "@/lib/voice/deck-prefs"
    );
    const next = !getBootGreetingMuted();
    setBootGreetingMuted(next);
    setMuted(next);
  }

  return (
    <div className="deck-stack border-t border-[var(--border)] pt-3">
      <label className="block font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]">
        Boot greeting
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="focus-magenta mt-1 w-full border border-[var(--border)] bg-transparent px-2 py-1 text-[var(--chrome)]"
        />
      </label>
      <p className="deck-note">Spoken once after boot.</p>
      <button
        type="button"
        onClick={() => void save()}
        className="focus-magenta self-start border border-[var(--purple)] px-4 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
      >
        {saved ? "Saved" : "Save greeting"}
      </button>
      <label className="flex items-center justify-between gap-3 font-[family-name:var(--font-body)] text-xs text-[var(--chrome)]">
        <span>Mute on boot — skip the spoken greeting</span>
        <span className="flex shrink-0 items-center gap-2">
          <span className={`deck-badge ${muted ? "is-warn" : "is-ok"}`}>
            {muted ? "◆ Boot muted" : "● Boot greets"}
          </span>
          <button
            type="button"
            onClick={() => void toggleMuted()}
            className="focus-magenta shrink-0 border border-[var(--border)] px-3 py-1 text-[10px] tracking-widest uppercase"
            aria-pressed={muted}
          >
            {muted ? "ON" : "OFF"}
          </button>
        </span>
      </label>
    </div>
  );
}

/**
 * SYNC REPLIES (G3). Default OFF per contract. Backed by
 * `@/lib/voice/deck-prefs` (SHARED CONTRACT §2).
 */
function SyncRepliesToggle() {
  const [on, setOn] = useState(false);

  useEffect(() => {
    void import("@/lib/voice/deck-prefs").then(({ getSyncReplies }) => {
      setOn(getSyncReplies());
    });
  }, []);

  async function toggle() {
    const { setSyncReplies, getSyncReplies } = await import(
      "@/lib/voice/deck-prefs"
    );
    const next = !getSyncReplies();
    setSyncReplies(next);
    setOn(next);
  }

  return (
    <div className="deck-stack border-t border-[var(--border)] pt-3">
      <label className="flex items-center justify-between gap-3 font-[family-name:var(--font-body)] text-xs text-[var(--chrome)]">
        <span>Sync replies to voice</span>
        <span className="flex shrink-0 items-center gap-2">
          <span className={`deck-badge ${on ? "is-ok" : "is-idle"}`}>
            {on ? "● Synced" : "○ Streaming"}
          </span>
          <button
            type="button"
            onClick={() => void toggle()}
            className="focus-magenta shrink-0 border border-[var(--border)] px-3 py-1 text-[10px] tracking-widest uppercase"
            aria-pressed={on}
          >
            {on ? "ON" : "OFF"}
          </button>
        </span>
      </label>
      <p className="deck-note">
        ON holds the text until her voice actually starts; OFF streams text
        first (better for long answers).
      </p>
    </div>
  );
}

/**
 * MIC MODE (G3) — three-way selector bound to Agent A's
 * `@/lib/voice/mic-state` (SHARED CONTRACT §1). Mirrors the same deliberate
 * two-step ARM/CONFIRM gate as MicStateBadge (src/components/bridge/
 * MicStateBadge.tsx) — OPEN MIC is a hard-rule state, reachable only by a
 * deliberate operator action everywhere it can be set, not just the deck
 * composer.
 */
function MicModeSetting() {
  const [mode, setMode] = useState<"muted" | "wake" | "open">("wake");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    void import("@/lib/voice/mic-state").then((m) => {
      setMode(m.getMicMode());
      unsubscribe = m.subscribeMicMode(setMode);
    });
    return () => unsubscribe?.();
  }, []);

  async function choose(next: "muted" | "wake" | "open") {
    const { setMicMode } = await import("@/lib/voice/mic-state");
    setMicMode(next);
    setMode(next);
    setConfirming(false);
  }

  const pillBase =
    "focus-magenta border px-3 py-1 font-[family-name:var(--font-display)] text-[10px] tracking-widest uppercase";

  return (
    <div className="deck-stack border-t border-[var(--border)] pt-3">
      <span className="flex flex-wrap items-center justify-between gap-2 font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]">
        Mic mode
        <span
          className={`deck-badge ${
            mode === "open" ? "is-danger" : mode === "wake" ? "is-ok" : "is-idle"
          }`}
        >
          {mode === "open"
            ? "◆ Open mic armed"
            : mode === "wake"
              ? "● Wake word"
              : "○ Muted"}
        </span>
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void choose("muted")}
          aria-pressed={mode === "muted"}
          className={`${pillBase} ${mode === "muted" ? "border-[var(--magenta)] text-[var(--magenta)]" : "border-[var(--border)] text-[var(--chrome)]"}`}
        >
          MUTED
        </button>
        <button
          type="button"
          onClick={() => void choose("wake")}
          aria-pressed={mode === "wake"}
          className={`${pillBase} ${mode === "wake" ? "border-[var(--magenta)] text-[var(--magenta)]" : "border-[var(--border)] text-[var(--chrome)]"}`}
        >
          WAKE WORD
        </button>
        {mode === "open" ? (
          <button
            type="button"
            onClick={() => void choose("wake")}
            aria-pressed
            className={`${pillBase} border-[var(--danger)] bg-[var(--danger)] text-[#1a0410]`}
          >
            DISARM (OPEN MIC ARMED)
          </button>
        ) : confirming ? (
          <span className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void choose("open")}
              className={`${pillBase} border-[var(--danger)] text-[var(--danger)]`}
            >
              CONFIRM ARM
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className={`${pillBase} border-[var(--border)] text-[var(--chrome)]`}
            >
              CANCEL
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            aria-pressed={false}
            className={`${pillBase} border-[var(--danger)] text-[var(--danger)]`}
          >
            ARM OPEN MIC…
          </button>
        )}
      </div>
      <p className="deck-note">
        OPEN MIC never survives a reload — it always comes back as WAKE WORD.
      </p>
    </div>
  );
}

export function VoicePicker() {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [autoName, setAutoName] = useState<string>("");
  const [piperReady, setPiperReady] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;
    void import("@/lib/voice/voice-select").then(
      ({ voicesReady, getStoredVoiceUri, pickStarraVoice }) => {
        void voicesReady().then((list) => {
          if (!mounted) return;
          setVoices(list);
          // Unset → Ara is the default primary voice.
          setSelected(getStoredVoiceUri() ?? "ara");
          setAutoName(pickStarraVoice(list)?.name ?? "system default");
        });
      },
    );
    void import("@/lib/voice/piper-speak").then(({ piperModelAvailable }) => {
      void piperModelAvailable().then((ok) => {
        if (mounted) setPiperReady(ok);
      });
    });
    return () => {
      mounted = false;
    };
  }, []);

  async function choose(uri: string) {
    const { setStoredVoiceUri } = await import("@/lib/voice/voice-select");
    setStoredVoiceUri(uri || null);
    setSelected(uri);
  }

  async function test() {
    const { speakStarra, stopAllSpeech } = await import("@/lib/voice/speak");
    stopAllSpeech();
    await speakStarra("Copy. STARGATE online. Standing by, operator.");
  }

  return (
    <section id="voice" className="deck-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="deck-title">STARRA voice</h2>
        <span
          className={`deck-badge ${
            piperReady === null ? "is-idle" : piperReady ? "is-ok" : "is-warn"
          }`}
        >
          {piperReady === null
            ? "○ Checking Piper"
            : piperReady
              ? "● Piper ready"
              : "◆ Piper offline"}
        </span>
      </div>
      <p className="deck-note">
        ● Eve (xAI TTS) — her one voice, the same British voice as the live
        call. Piper Cori and Web Speech are fallback only, used offline or when
        xAI is unreachable.{" "}
        {piperReady === null
          ? "Checking Piper model…"
          : piperReady
            ? "Piper ready."
            : "Piper offline — run: npm run voice:download."}
      </p>
      <p className="deck-note">
        Pick a specific Web Speech voice to override her. AUTO prefers British
        English female — current auto pick: {autoName}.
      </p>
      <select
        value={selected}
        onChange={(e) => void choose(e.target.value)}
        className="focus-magenta w-full border border-[var(--border)] bg-[var(--void)] px-2 py-2 font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]"
        aria-label="STARRA voice"
      >
        <option value="ara">Eve (xAI) — her voice, same as the call</option>
        <option value="auto">AUTO — Web Speech picks</option>
        {voices.map((v) => (
          <option key={v.voiceURI} value={v.voiceURI}>
            {v.name} ({v.lang})
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => void test()}
        className="focus-magenta self-start border border-[var(--purple)] px-4 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
      >
        Test voice
      </button>
      <BootGreetingSettings />
      <SyncRepliesToggle />
      <MicModeSetting />
    </section>
  );
}
