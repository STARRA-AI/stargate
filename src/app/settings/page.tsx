"use client";

import { ScreenShell } from "@/components/hud/ScreenShell";
import type { Tier1Data } from "@/lib/context/tier1";
import { useEffect, useState } from "react";

function LlmStatus() {
  const [status, setStatus] = useState<string>("CHECKING LINK");

  useEffect(() => {
    fetch("/api/llm/status")
      .then((r) => r.json())
      .then(
        (d: {
          ollama?: {
            up?: boolean;
            hasModel?: boolean;
            model?: string;
            reasoning?: string;
          };
          anthropic?: boolean;
          priority?: string;
          soul?: { loaded?: boolean; truncated?: boolean };
        }) => {
          const o = d.ollama;
          const soulBit = d.soul?.loaded
            ? d.soul.truncated
              ? " · soul loaded (trimmed)"
              : " · soul loaded"
            : " · soul offline";
          if (!o?.up) {
            setStatus(`○ OLLAMA OFFLINE — run: ollama serve${soulBit}`);
            return;
          }
          if (!o.hasModel) {
            setStatus(`○ MODEL MISSING — ollama pull ${o.model}${soulBit}`);
            return;
          }
          setStatus(
            `● ${o.model} · ${o.reasoning ?? "fable scaffold"} · ${d.priority ?? "auto"}${d.anthropic ? " · anthropic keyed" : ""}${soulBit}`,
          );
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
    <label className="flex items-center justify-between gap-3 font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]">
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
          setSelected(getStoredVoiceUri() ?? "");
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
        {piperReady === null
          ? "Checking Piper Cori model…"
          : piperReady
            ? "● Piper Cori en_GB high — primary voice (~1s/sentence on this machine). Web Speech below is fallback only."
            : "○ Piper offline — run: npm run voice:download. Web Speech fallback active."}
      </p>
      <p className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--star)]">
        Web Speech AUTO prefers British English female, then Japanese female.
        Current auto pick: {autoName}.
      </p>
      <select
        value={selected}
        onChange={(e) => void choose(e.target.value)}
        className="focus-magenta w-full border border-[var(--border)] bg-[var(--void)] px-2 py-2 font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]"
        aria-label="STARRA voice"
      >
        <option value="">AUTO — STARRA picks</option>
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
};

function KeyVault() {
  const [slots, setSlots] = useState<KeySlot[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState("");

  const load = () =>
    fetch("/api/keys")
      .then((r) => r.json())
      .then((d: { slots: KeySlot[] }) => setSlots(d.slots));

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    const patch = Object.fromEntries(
      Object.entries(values).filter(([, v]) => v.trim() !== ""),
    );
    if (!Object.keys(patch).length) return;
    const res = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    setSaved(res.ok ? "KEYS STORED — panels go live on next refresh" : "LINK DEGRADED. RETRY?");
    setValues({});
    await load();
  }

  return (
    <section id="link-apis" className="panel-etch space-y-3 p-4 md:col-span-2">
      <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.28em] text-[var(--star)] uppercase">
        Link APIs
      </h2>
      <p className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--star)]">
        Paste a key, hit STORE. Keys live in data/keys.json on this machine
        only — never committed. Each key lights up the panel listed next to
        it.
      </p>
      <div className="grid gap-3 md:grid-cols-2">
        {slots.map((s) => (
          <label
            key={s.id}
            className="block font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]"
          >
            <span className="flex items-center gap-2">
              {s.label}
              <span
                className={
                  s.linked ? "text-[var(--ok)]" : "text-[var(--danger)]"
                }
              >
                {s.linked ? `● linked ${s.masked}` : "○ not linked"}
              </span>
            </span>
            <span className="block text-[10px] text-[var(--star)]">
              powers: {s.powers}
            </span>
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
  const [intensity, setIntensity] = useState(70);
  const [voiceGain, setVoiceGain] = useState(80);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    fetch("/api/context")
      .then((r) => r.json())
      .then((d: { tier1: Tier1Data }) => setTier1(d.tier1));
  }, []);

  async function saveContext() {
    if (!tier1) return;
    const res = await fetch("/api/context", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tier1),
    });
    setSaved(res.ok ? "STORED" : "LINK DEGRADED. RETRY?");
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
          <label className="block font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]">
            Theme intensity
            <input
              type="range"
              min={30}
              max={100}
              value={intensity}
              onChange={(e) => setIntensity(Number(e.target.value))}
              className="mt-2 w-full accent-[var(--magenta)]"
            />
          </label>
          <label className="block font-[family-name:var(--font-mono)] text-xs text-[var(--chrome)]">
            Voice level
            <input
              type="range"
              min={0}
              max={100}
              value={voiceGain}
              onChange={(e) => setVoiceGain(Number(e.target.value))}
              className="mt-2 w-full accent-[var(--purple)]"
            />
          </label>
          <WakeWordToggle />
          <p className="font-[family-name:var(--font-mono)] text-[11px] text-[var(--star)]">
            Wake: say &quot;starra&quot; or ⌥ + Space · Launch:{" "}
            <span className="text-[var(--magenta)]">npm run starra</span> · Brain:
            local Ollama (qwen2.5:1.5b) · Anthropic optional
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
