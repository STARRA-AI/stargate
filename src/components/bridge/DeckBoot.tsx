"use client";

import Image from "next/image";
import { COPY } from "@/lib/copy";
import { MOTION } from "@/lib/motion/assets";
import { useEffect, useRef, useState } from "react";

/* Canonical boot sequence — single source of truth is COPY.boot. */
const BOOT_LINES = COPY.boot;

export function DeckBoot({ onDone }: { onDone: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [pct, setPct] = useState(0);
  const [phase, setPhase] = useState<"run" | "fading" | "hidden">("run");
  const bootCineRef = useRef<HTMLVideoElement>(null);

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

  /* panel_boot.webm — one-shot stage ignition behind boot chrome */
  useEffect(() => {
    const el = bootCineRef.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const eco = document.body.classList.contains("low-power");
    if (reduce || eco) return;

    el.src = MOTION.panelBoot;
    el.muted = true;
    el.playsInline = true;
    el.loop = false;
    const play = () => {
      void el.play().catch(() => {});
    };
    if (el.readyState >= 2) play();
    else el.addEventListener("canplay", play, { once: true });

    return () => {
      el.pause();
      el.removeEventListener("canplay", play);
    };
  }, []);

  if (phase === "hidden") return null;

  return (
    <div id="boot-overlay" className={phase === "fading" ? "fading" : undefined}>
      <video
        ref={bootCineRef}
        className="boot-cine"
        muted
        playsInline
        preload="metadata"
        aria-hidden
      />
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
