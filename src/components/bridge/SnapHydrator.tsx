"use client";

import { useStargate } from "@/lib/stargate-context";
import { useEffect } from "react";

/** Pull Tier-1 + memory counts into Bridge snap on mount. */
export function SnapHydrator() {
  const { setSnap } = useStargate();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/context");
        if (!res.ok) return;
        const data = (await res.json()) as {
          snap: {
            mrrLabel: string;
            tasksDue: number;
            pipelineOpen: number;
            working: number;
            summaries: number;
            archival: number;
          };
        };
        if (!cancelled) setSnap(data.snap);
      } catch {
        /* offline seed stays */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setSnap]);

  return null;
}
