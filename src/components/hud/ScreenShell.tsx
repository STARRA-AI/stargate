"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { Starfield } from "@/components/bridge/Starfield";
import { revealAll } from "@/lib/ui/motion";

export function ScreenShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const mainRef = useRef<HTMLElement | null>(null);

  // ONE INSERTION POINT FOR THE WHOLE BACK END. Every screen except the Bridge
  // wraps in this shell, so animating panels here reaches all of them without
  // eight near-identical edits — and without any screen inventing its own
  // cadence. `revealAll` is a no-op under prefers-reduced-motion, and it only
  // ever runs on mount: nothing here loops, so the reactor stays the deck's
  // single animated focal point (design doctrine).
  useEffect(() => {
    const panels = mainRef.current?.querySelectorAll(".deck-panel");
    if (!panels || panels.length === 0) return; // a screen with no panels yet
    revealAll(panels);
  }, []);

  return (
    <div className="relative min-h-dvh bg-[var(--void)] text-[var(--chrome)]">
      <Starfield />
      <div className="relative z-10 mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 px-4 py-6 md:px-8">
        <header className="flex items-center gap-4">
          <Link href="/" className="focus-magenta shrink-0" aria-label="Return to Bridge">
            <Image
              src="/brand/badge.webp"
              alt=""
              width={44}
              height={44}
              className="object-contain mix-blend-screen"
            />
          </Link>
          <div>
            <p className="font-[family-name:var(--font-display)] text-[10px] tracking-[0.35em] text-[var(--star)] uppercase">
              STARGATE
            </p>
            <h1 className="font-[family-name:var(--font-display)] text-lg tracking-[0.2em] text-[var(--chrome)] uppercase">
              {title}
            </h1>
          </div>
          <Link
            href="/"
            className="ml-auto font-[family-name:var(--font-mono)] text-[10px] tracking-widest text-[var(--purple)] uppercase"
          >
            Bridge
          </Link>
        </header>
        <main ref={mainRef} className="flex flex-1 flex-col gap-4">
          {children}
        </main>
      </div>
    </div>
  );
}
