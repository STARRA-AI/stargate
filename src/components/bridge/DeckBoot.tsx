"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

const BOOT_LINES = [
  "INITIALIZING STARGATE KERNEL",
  "LOADING MEMORY BANKS ... READY",
  "LINKING STARRA BRAIN ... OK",
  "LOADING STARRA SOUL ... OK",
  "VOICE LOOP + OLLAMA ... ONLINE",
  "DRAGON TRADAR MODULE ... DEMO MODE",
  "THINK TANK ENSEMBLE ... DEMO MODE",
  "ALL SYSTEMS NOMINAL",
];

export function DeckBoot({ onDone }: { onDone: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [pct, setPct] = useState(0);
  const [phase, setPhase] = useState<"run" | "fading" | "hidden">("run");

  useEffect(() => {
    let cancelled = false;

    async function run() {
      for (let i = 0; i < BOOT_LINES.length; i++) {
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 320));
        setLines((prev) => [...prev.slice(-3), BOOT_LINES[i]]);
        setPct(Math.round(((i + 1) / BOOT_LINES.length) * 100));
      }
      if (cancelled) return;
      await new Promise((r) => setTimeout(r, 450));
      setPhase("fading");
      await new Promise((r) => setTimeout(r, 600));
      if (cancelled) return;
      setPhase("hidden");
      onDone();
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [onDone]);

  if (phase === "hidden") return null;

  return (
    <div id="boot-overlay" className={phase === "fading" ? "fading" : undefined}>
      <Image
        className="boot-badge"
        src="/brand/badge.png"
        alt=""
        width={110}
        height={110}
        priority
      />
      <Image
        className="boot-wordmark"
        src="/brand/wordmark.png"
        alt="STARRA"
        width={280}
        height={80}
        priority
      />
      <div className="boot-bar-track">
        <div className="boot-bar-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="boot-lines">
        {lines.map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
    </div>
  );
}
