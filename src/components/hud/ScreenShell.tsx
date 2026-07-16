"use client";

import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Starfield } from "@/components/bridge/Starfield";

export function ScreenShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="relative min-h-dvh bg-[var(--void)] text-[var(--chrome)]">
      <Starfield />
      <div className="relative z-10 mx-auto flex min-h-dvh max-w-5xl flex-col px-4 py-5 md:px-8">
        <header className="mb-6 flex items-center gap-4">
          <Link href="/" className="focus-magenta shrink-0" aria-label="Return to Bridge">
            <Image
              src="/brand/badge.png"
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
        {children}
      </div>
    </div>
  );
}
