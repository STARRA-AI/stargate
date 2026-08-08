"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import { Starfield } from "@/components/bridge/Starfield";
import { Skeleton } from "@/components/hud/Skeleton";
import { revealAll } from "@/lib/ui/motion";

/** Rows of structure to hold the screen open while its first fetch is in the
 *  air. Four reads as "a panel is coming" without pretending to know the
 *  shape of a payload nobody has seen yet. */
const SKELETON_ROWS = 4;

export function ScreenShell({
  title,
  loading = false,
  children,
}: {
  title: string;
  /** True while the screen's FIRST fetch is outstanding. Omitted = never
   *  loading, so every existing caller behaves exactly as before. */
  loading?: boolean;
  children: ReactNode;
}) {
  const mainRef = useRef<HTMLElement | null>(null);

  // ONE INSERTION POINT FOR THE WHOLE BACK END. Every screen except the Bridge
  // wraps in this shell, so animating panels here reaches all of them without
  // eight near-identical edits — and without any screen inventing its own
  // cadence. `revealAll` is a no-op under prefers-reduced-motion, and it only
  // ever runs on mount or the moment loading clears: nothing here loops, so the
  // reactor stays the deck's single animated focal point (design doctrine).
  //
  // `loading` MUST stay in the deps. Real panels do not exist during the
  // skeleton pass, so a mount-only effect would find zero of them, bail, and
  // never fire again — the content would arrive with no reveal at all. For a
  // caller that never passes `loading` the value never changes, so this is
  // byte-for-byte the old mount-only behaviour.
  useEffect(() => {
    if (loading) return;
    const panels = mainRef.current?.querySelectorAll(".deck-panel");
    if (!panels || panels.length === 0) return; // a screen with no panels yet
    revealAll(panels);
  }, [loading]);

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
          {loading ? <Skeleton rows={SKELETON_ROWS} /> : children}
        </main>
      </div>
    </div>
  );
}
