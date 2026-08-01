"use client";

import { ScreenShell } from "@/components/hud/ScreenShell";
import type { Tier1Data } from "@/lib/context/tier1";
import { KEY_GROUP_LABELS, KEY_SLOTS } from "@/lib/keys";
import { useEffect, useState } from "react";

function LlmStatus() {
  const [status, setStatus] = useState<string>("CHECKING LINK");

  useEffect(() => {
    fetch("/api/llm/status")
      .then((r) => r.json())
      .then(
        (d: {
          provider?: string;
          freellm?: boolean;
          ollama?: { up?: boolean; hasModel?: boolean; model?: string };
          anthropic?: boolean;
          groq?: boolean;
          grok?: boolean;
          groqModel?: string;
          grokModel?: string;
          soul?: { loaded?: boolean; truncated?: boolean };
        }) => {
          const o = d.ollama;
          const soulBit = d.soul?.loaded
            ? d.soul.truncated
              ? " · soul trimmed"
              : " · soul loaded"
            : " · soul offline";
          // Active daily driver from LLM_PROVIDER, then the local fallback state.
          const p = (d.provider ?? "auto").toLowerCase();
          const brain =
            p === "kimi"
              ? `Kimi/Groq (${d.groqModel})${d.groq ? "" : " — NO KEY"}`
              : p === "grok"
                ? `Grok (${d.grokModel})${d.grok ? "" : " — NO KEY"}`
                : p === "anthropic"
                  ? `Anthropic${d.anthropic ? "" : " — NO KEY"}`
                  : p === "freellm"
                    ? `FreeLLM router (local)${d.freellm ? "" : " — NO KEY"}`
                    : p === "ollama"
                      ? `local Ollama (${o?.model})`
                      : "auto";
          const fallback =
            o?.up && o?.hasModel
              ? `Ollama ${o.model} ready`
              : o?.up
                ? `Ollama up — pull ${o?.model}`
                : "Ollama offline";
          setStatus(`● Brain: ${brain} · fallback: ${fallback}${soulBit}`);
        },
      )
      .catch(() => setStatus("◆ LINK DEGRADED"));
  }, []);

  return (
    <p className="font-[family-name:var(--font-mono)] text-[10px] tracking-wide text-[var(--magenta)] uppercase">
      {status}
    </p>
  );
}

function WakeWordToggle() {
  const [on, setOn] = useState(true);

  useEffect(() => {
    void import("@/lib/voice/wake-word").then(({ getWakeWordEnabled }) => {
      setOn(getWakeWordEnabled());
    });
  }, []);

  async function toggle() {
    const { setWakeWordEnabled, getWakeWordEnabled } = await import(
      "@/lib/voice/wake-word"
    );
    setWakeWordEnabled(!getWakeWordEnabled());
    setOn(getWakeWordEnabled());
  }

  return (
    <label className="flex items-center justify-between gap-3 font-[family-name:var(--font-body)] text-xs text-[var(--chrome)]">
      <span>
        Wake word — say &quot;starra&quot; (mic stays listening while deck is open)
      </span>
      <button
        type="button"
        onClick={() => void toggle()}
        className="focus-magenta shrink-0 border border-[var(--border)] px-3 py-1 text-[10px] tracking-widest uppercase"
        aria-pressed={on}
      >
        {on ? "ON" : "OFF"}
      </button>
    </label>
  );
}

/**
 * BOOT GREETING + MUTE ON BOOT (G2). Backed by Agent A's
 * `@/lib/voice/deck-prefs` (SHARED CONTRACT §2), imported dynamically the
 * same way WakeWordToggle imports wake-word above.
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
    <div className="space-y-2 border-t border-[var(--border)] pt-3">
      <label className="block font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]">
        Boot greeting
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="focus-magenta mt-1 w-full border border-[var(--border)] bg-transparent px-2 py-1 text-[var(--chrome)]"
        />
      </label>
      <p className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--star)]">
        Spoken once after boot.
      </p>
      <button
        type="button"
        onClick={() => void save()}
        className="focus-magenta border border-[var(--purple)] px-4 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
      >
        {saved ? "Saved" : "Save greeting"}
      </button>
      <label className="flex items-center justify-between gap-3 font-[family-name:var(--font-body)] text-xs text-[var(--chrome)]">
        <span>Mute on boot — skip the spoken greeting</span>
        <button
          type="button"
          onClick={() => void toggleMuted()}
          className="focus-magenta shrink-0 border border-[var(--border)] px-3 py-1 text-[10px] tracking-widest uppercase"
          aria-pressed={muted}
        >
          {muted ? "ON" : "OFF"}
        </button>
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
    <div className="space-y-1 border-t border-[var(--border)] pt-3">
      <label className="flex items-center justify-between gap-3 font-[family-name:var(--font-body)] text-xs text-[var(--chrome)]">
        <span>Sync replies to voice</span>
        <button
          type="button"
          onClick={() => void toggle()}
          className="focus-magenta shrink-0 border border-[var(--border)] px-3 py-1 text-[10px] tracking-widest uppercase"
          aria-pressed={on}
        >
          {on ? "ON" : "OFF"}
        </button>
      </label>
      <p className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--star)]">
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
    <div className="space-y-2 border-t border-[var(--border)] pt-3">
      <span className="block font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]">
        Mic mode
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
      <p className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--star)]">
        OPEN MIC never survives a reload — it always comes back as WAKE WORD.
      </p>
    </div>
  );
}

function VoicePicker() {
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
    <section id="voice" className="panel-etch space-y-3 p-4">
      <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
        STARRA voice
      </h2>
      <p className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--star)]">
        ● Eve (xAI TTS) — her one voice, the same British voice as the live
        call. Piper Cori and Web Speech are fallback only, used offline or when
        xAI is unreachable.{" "}
        {piperReady === null
          ? "Checking Piper model…"
          : piperReady
            ? "Piper ready."
            : "Piper offline — run: npm run voice:download."}
      </p>
      <p className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--star)]">
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
        className="focus-magenta border border-[var(--purple)] px-4 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
      >
        Test voice
      </button>
      <BootGreetingSettings />
      <SyncRepliesToggle />
      <MicModeSetting />
    </section>
  );
}

type KeySlot = {
  id: string;
  label: string;
  hint: string;
  powers: string;
  linked: boolean;
  masked: string | null;
  /** Which store the live value came from — see /api/keys. */
  source?: "engine" | "vault" | "env" | null;
  /** An Options-panel override outranks anything saved on THIS page. */
  shadowedByEngine?: boolean;
};

/**
 * THE SHADOWING, SPELLED OUT. getKey() resolves engine.json keyOverride →
 * data/keys.json → process.env (src/lib/keys.ts:16-27). This page writes the
 * MIDDLE store. So when the Options panel already holds a key for a slot, a key
 * pasted here saves but never takes effect. The order is correct; hiding it was
 * not. These two labels are how the page says so.
 */
const SOURCE_LABEL: Record<string, string> = {
  engine: "OPTIONS PANEL",
  vault: "THIS PAGE",
  env: ".ENV.LOCAL",
};

// Display-only grouping — KEY_SLOTS in lib/keys.ts is the single source of
// truth for id → group; /api/keys doesn't forward `group`, so it's resolved
// client-side from the same constant the API reads its slots from.
const SLOT_GROUP = new Map<string, string>(
  KEY_SLOTS.map((s) => [s.id, s.group]),
);
const SLOT_LABEL = new Map<string, string>(KEY_SLOTS.map((s) => [s.id, s.label]));
const GROUP_ORDER: string[] = [];
for (const s of KEY_SLOTS) {
  if (!GROUP_ORDER.includes(s.group)) GROUP_ORDER.push(s.group);
}

function KeyVault() {
  const [slots, setSlots] = useState<KeySlot[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState("");

  const load = () =>
    fetch("/api/keys")
      .then((r) => r.json())
      .then((d: { slots?: KeySlot[] }) => setSlots(d.slots ?? []))
      .catch(() => setSlots([]));

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    const patch = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v.trim() !== ""),
    );
    if (!Object.keys(patch).length) return;
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      // The route names the slots this save cannot affect — an Options override
      // outranks the vault, so "KEYS STORED" alone would be a lie for them.
      let shadowed: string[] = [];
      try {
        const d = (await res.json()) as { shadowed?: string[] };
        if (Array.isArray(d.shadowed)) shadowed = d.shadowed;
      } catch {
        /* a body we cannot read never downgrades the HTTP verdict below */
      }
      if (!res.ok) {
        setSaved("LINK DEGRADED. RETRY?");
      } else if (shadowed.length > 0) {
        const names = shadowed.map((id) => SLOT_LABEL.get(id) ?? id).join(" · ");
        setSaved(
          `STORED BUT OUTRANKED — ${names}: the Options panel holds an override for ${shadowed.length === 1 ? "that slot" : "those slots"}, so this value is not in use. Clear it in OPTIONS to hand control back here.`,
        );
      } else {
        setSaved("KEYS STORED — panels go live on next refresh");
      }
      setValues({});
      await load();
    } catch {
      setSaved("LINK DEGRADED. RETRY?");
    }
  }

  return (
    <section id="link-apis" className="panel-etch space-y-3 p-4 md:col-span-2">
      <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
        Link APIs
      </h2>
      <p className="font-[family-name:var(--font-body)] text-[11px] text-[var(--star)]">
        Paste a key, hit STORE KEYS. Keys live in data/keys.json on this
        machine only — never committed. Each key lights up the panel listed
        next to it.
      </p>
      {GROUP_ORDER.map((group) => {
        const items = slots.filter((s) => SLOT_GROUP.get(s.id) === group);
        if (!items.length) return null;
        return (
          <div key={group} className="space-y-3">
            <h3 className="font-[family-name:var(--font-display)] text-[10px] tracking-[0.28em] text-[var(--star)] uppercase">
              {KEY_GROUP_LABELS[group] ?? group}
            </h3>
            <div className="grid gap-3 md:grid-cols-2">
              {items.map((s) => (
                <label
                  key={s.id}
                  className="block font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]"
                >
                  <span className="flex flex-wrap items-center gap-2">
                    {s.label}
                    <span
                      className={
                        s.linked ? "text-[var(--ok)]" : "text-[var(--danger)]"
                      }
                    >
                      {s.linked ? `● linked ${s.masked}` : "○ not linked"}
                    </span>
                    {s.linked && s.source && (
                      <span className="text-[10px] tracking-widest text-[var(--star)] uppercase">
                        via {SOURCE_LABEL[s.source] ?? s.source}
                      </span>
                    )}
                    {s.shadowedByEngine && (
                      <span className="border border-[var(--danger)] px-1 text-[10px] tracking-widest text-[var(--danger)] uppercase">
                        OVERRIDDEN IN OPTIONS
                      </span>
                    )}
                  </span>
                  <span className="block text-[10px] text-[var(--star)]">
                    powers: {s.powers}
                  </span>
                  {s.shadowedByEngine && (
                    <span className="block text-[10px] text-[var(--danger)]">
                      The Options panel holds a key for this slot and it outranks
                      this page. Anything stored here will save but stay unused —
                      clear the override in OPTIONS first.
                    </span>
                  )}
                  <input
                    type="password"
                    placeholder={s.hint}
                    value={values[s.id] ?? ""}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [s.id]: e.target.value }))
                    }
                    className="focus-magenta mt-1 w-full border border-[var(--border)] bg-transparent px-2 py-1 text-[var(--chrome)]"
                  />
                </label>
              ))}
            </div>
          </div>
        );
      })}
      <button
        type="button"
        onClick={() => void save()}
        className="focus-magenta border border-[var(--purple)] px-4 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
      >
        Store keys
      </button>
      {saved && (
        <span className="ml-3 font-[family-name:var(--font-mono)] text-xs text-[var(--magenta)]">
          {saved}
        </span>
      )}
    </section>
  );
}

export default function SettingsPage() {
  const [tier1, setTier1] = useState<Tier1Data | null>(null);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    fetch("/api/context")
      .then((r) => r.json())
      .then((d: { tier1?: Tier1Data }) => {
        if (d.tier1) setTier1(d.tier1);
      })
      .catch(() => {
        /* PROCESSING state stays until a manual retry */
      });
  }, []);

  async function saveContext() {
    if (!tier1) return;
    try {
      const res = await fetch("/api/context", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tier1),
      });
      setSaved(res.ok ? "STORED" : "LINK DEGRADED. RETRY?");
    } catch {
      setSaved("LINK DEGRADED. RETRY?");
    }
  }

  return (
    <ScreenShell title="Settings">
      <div className="grid gap-5 md:grid-cols-2">
        <KeyVault />
        <VoicePicker />
        <section className="panel-etch space-y-4 p-4">
          <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
            Deck
          </h2>
          <WakeWordToggle />
          <p className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--star)]">
            Wake: say &quot;starra&quot; or ⌥ + Space · Launch:{" "}
            <span className="text-[var(--magenta)]">npm run starra</span> · Brain:
            Kimi/Groq daily driver · Grok opt-in · Ollama fallback
          </p>
          <LlmStatus />
        </section>

        <section className="panel-etch space-y-3 p-4">
          <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
            Tier-1 context
          </h2>
          {!tier1 ? (
            <p className="font-[family-name:var(--font-mono)] text-xs text-[var(--star)]">
              PROCESSING
            </p>
          ) : (
            <>
              <label className="block font-[family-name:var(--font-mono)] text-xs">
                MRR label
                <input
                  className="focus-magenta mt-1 w-full border border-[var(--border)] bg-transparent px-2 py-1 text-[var(--chrome)]"
                  value={tier1.mrrLabel}
                  onChange={(e) =>
                    setTier1({ ...tier1, mrrLabel: e.target.value })
                  }
                />
              </label>
              <p className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--star)]">
                {tier1.tasks.filter((t) => !t.done).length} open tasks ·{" "}
                {tier1.projects.filter((p) => p.status === "active").length}{" "}
                active projects · {tier1.goals.length} goals
              </p>
              <textarea
                className="focus-magenta min-h-32 w-full border border-[var(--border)] bg-transparent p-2 font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]"
                value={tier1.tasks.map((t) => t.title).join("\n")}
                onChange={(e) => {
                  const lines = e.target.value.split("\n").filter(Boolean);
                  setTier1({
                    ...tier1,
                    tasks: lines.map((title, i) => ({
                      id: tier1.tasks[i]?.id ?? `t-${i}`,
                      title,
                      owner: "Classic",
                      priority: "med",
                      done: false,
                      due: tier1.tasks[i]?.due,
                    })),
                  });
                }}
              />
              <button
                type="button"
                onClick={() => void saveContext()}
                className="focus-magenta border border-[var(--purple)] px-4 py-2 font-[family-name:var(--font-display)] text-[10px] tracking-[0.25em] uppercase"
              >
                Save context
              </button>
              {saved && (
                <span className="ml-3 font-[family-name:var(--font-mono)] text-xs text-[var(--magenta)]">
                  {saved}
                </span>
              )}
            </>
          )}
        </section>
      </div>
    </ScreenShell>
  );
}
