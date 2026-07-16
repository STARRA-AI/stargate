"use client";

import { ScreenShell } from "@/components/hud/ScreenShell";
import { COPY } from "@/lib/copy";
import { useEffect, useState } from "react";

type Card = {
  id: string;
  title: string;
  stage: "triage" | "active" | "blocked" | "won";
  nextStep: string;
};

const SEED: Card[] = [
  {
    id: "1",
    title: "Plus Ultra — Nashville HVAC outbound",
    stage: "active",
    nextStep: "Send 10 cold emails to HVAC list; log replies",
  },
  {
    id: "2",
    title: "Silent Shadow — Shorts cadence",
    stage: "active",
    nextStep: "Film Thu block; caption QA before publish",
  },
  {
    id: "3",
    title: "Business credit — Net-30 stack",
    stage: "triage",
    nextStep: "Open Uline account after DUNS lands",
  },
  {
    id: "4",
    title: "Dragon Tradar — Replit remote",
    stage: "blocked",
    nextStep: "Need Repl git URL for push_to_replit",
  },
];

const STAGES: Card["stage"][] = ["triage", "active", "blocked", "won"];

export default function PipelinePage() {
  const [cards, setCards] = useState<Card[]>(SEED);

  useEffect(() => {
    const raw = localStorage.getItem("stargate-pipeline");
    if (raw) {
      try {
        setCards(JSON.parse(raw) as Card[]);
      } catch {
        /* keep seed */
      }
    }
  }, []);

  useEffect(() => {
    localStorage.setItem("stargate-pipeline", JSON.stringify(cards));
  }, [cards]);

  return (
    <ScreenShell title="Pipeline">
      {cards.length === 0 ? (
        <p className="font-[family-name:var(--font-mono)] text-[var(--star)]">
          {COPY.emptyPipeline}
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-4">
          {STAGES.map((stage) => (
            <div key={stage} className="flex flex-col gap-3">
              <h2 className="font-[family-name:var(--font-display)] text-[11px] tracking-[0.3em] text-[var(--star)] uppercase">
                {stage}
              </h2>
              {cards
                .filter((c) => c.stage === stage)
                .map((c) => (
                  <article key={c.id} className="panel-etch p-3">
                    <h3 className="font-[family-name:var(--font-body)] text-base font-semibold text-[var(--chrome)]">
                      {c.title}
                    </h3>
                    <p className="mt-2 font-[family-name:var(--font-mono)] text-[11px] leading-relaxed text-[var(--magenta)]">
                      NEXT: {c.nextStep}
                    </p>
                  </article>
                ))}
            </div>
          ))}
        </div>
      )}
    </ScreenShell>
  );
}
