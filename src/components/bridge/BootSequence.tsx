"use client";

import { COPY } from "@/lib/copy";
import { useEffect, useState } from "react";

type Props = {
  onDone: () => void;
};

export function BootSequence({ onDone }: Props) {
  const [index, setIndex] = useState(0);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (sessionStorage.getItem("stargate-boot-seen") === "1") {
      setHidden(true);
      onDone();
      return;
    }

    const timers: number[] = [];
    COPY.boot.forEach((_, i) => {
      timers.push(
        window.setTimeout(() => setIndex(i + 1), 400 + i * 450),
      );
    });
    timers.push(
      window.setTimeout(() => {
        sessionStorage.setItem("stargate-boot-seen", "1");
        setHidden(true);
        onDone();
      }, 1800),
    );

    return () => timers.forEach((t) => clearTimeout(t));
  }, [onDone]);

  if (hidden) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-[var(--void)]"
      role="status"
      aria-live="polite"
    >
      <button
        type="button"
        className="focus-magenta absolute top-6 right-6 font-[family-name:var(--font-mono)] text-[11px] tracking-[0.25em] text-[var(--star)] uppercase"
        onClick={() => {
          sessionStorage.setItem("stargate-boot-seen", "1");
          setHidden(true);
          onDone();
        }}
      >
        SKIP
      </button>
      {COPY.boot.slice(0, index).map((line) => (
        <p
          key={line}
          className="font-[family-name:var(--font-display)] text-sm tracking-[0.35em] text-[var(--chrome)] uppercase"
          style={{ animation: "boot-line 300ms ease-out" }}
        >
          {line}
        </p>
      ))}
    </div>
  );
}
