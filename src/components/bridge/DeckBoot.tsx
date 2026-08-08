"use client";

import Image from "next/image";
import { COPY } from "@/lib/copy";
import { MOTION } from "@/lib/motion/assets";
import { useEffect, useRef, useState } from "react";

/* Canonical boot sequence — single source of truth is COPY.boot. */
const BOOT_LINES = COPY.boot;

/* Book 1's boot budget is 1800ms, and these three numbers ARE that budget:
   8 lines x 120ms stagger + 380ms hold + 460ms fade = 1800ms. Change one and
   the deck no longer boots to spec — there is no test guarding this. */
const LINE_MS = 120;
const HOLD_MS = 380;
/* deck.css:1625 fades #boot-overlay over 0.6s. That number was chosen to match
   the OLD 600ms hold; at 460ms the overlay would unmount ~97% through its own
   fade and pop. Drive the transition from here so the fade and the hold are one
   number, not two that silently drift apart. */
const FADE_MS = 460;

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
        await new Promise((r) => setTimeout(r, LINE_MS));
        setLines((prev) => [...prev.slice(-3), BOOT_LINES[i]]);
        setPct(Math.round(((i + 1) / BOOT_LINES.length) * 100));
      }
      if (cancelled) return;
      await new Promise((r) => setTimeout(r, HOLD_MS));
      setPhase("fading");
      await new Promise((r) => setTimeout(r, FADE_MS));
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
    <div
      id="boot-overlay"
      className={phase === "fading" ? "fading" : undefined}
      style={{ transitionDuration: `${FADE_MS}ms` }}
    >
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
