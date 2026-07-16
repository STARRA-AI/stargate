"use client";

import Image from "next/image";
import { useStargate } from "@/lib/stargate-context";

type Props = {
  onMic?: () => void;
  large?: boolean;
};

export function ReactorCore({ onMic, large }: Props) {
  const { hudState, statusLine } = useStargate();

  const badgeClass =
    hudState === "listening" || hudState === "wake"
      ? "badge-listening"
      : hudState === "thinking"
        ? "badge-thinking"
        : hudState === "speaking" || hudState === "streaming"
          ? "badge-listening"
          : "badge-idle";

  const size = large ? 280 : 320;
  const badge = large ? 110 : 96;

  return (
    <div className="relative flex flex-col items-center justify-center">
      <div
        className="relative"
        style={{ width: size, height: size }}
      >
        <Image
          src="/brand/hud_ring.png"
          alt=""
          width={size}
          height={size}
          className="ring-outer pointer-events-none absolute inset-0 h-full w-full object-contain opacity-90 mix-blend-screen"
          priority
        />
        <Image
          src="/brand/hud_ring.png"
          alt=""
          width={Math.round(size * 0.72)}
          height={Math.round(size * 0.72)}
          className="ring-inner pointer-events-none absolute top-1/2 left-1/2 object-contain opacity-70 mix-blend-screen"
          style={{
            width: size * 0.72,
            height: size * 0.72,
            transform: "translate(-50%, -50%)",
          }}
          priority
        />
        <button
          type="button"
          aria-label="Microphone — tap to speak"
          onClick={onMic}
          className={`focus-magenta absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 ${badgeClass}`}
        >
          <Image
            src="/brand/badge.png"
            alt="STARRA mic"
            width={badge}
            height={badge}
            className="object-contain mix-blend-screen"
            priority
          />
        </button>
      </div>
      <p className="mt-3 font-[family-name:var(--font-display)] text-[11px] tracking-[0.4em] text-[var(--magenta)] uppercase">
        {statusLine}
      </p>
    </div>
  );
}
