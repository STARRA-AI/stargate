"use client";

import { ScreenShell } from "@/components/hud/ScreenShell";
import { useEffect, useState } from "react";

export default function BriefPage() {
  const [text, setText] = useState("PROCESSING");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [
              {
                role: "user",
                content:
                  "Give me the brief. Top 3 moves today, blockers, what changed. Operator voice. Short.",
              },
            ],
          }),
        });
        if (!res.body) {
          setText("LINK DEGRADED. RETRY?");
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let full = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const json = JSON.parse(payload) as { text?: string };
              if (json.text) full += json.text;
            } catch {
              /* ignore */
            }
          }
        }
        setText(full || "NOTHING PENDING.");
      } catch {
        setText("LINK DEGRADED. RETRY?");
      }
    })();
  }, []);

  return (
    <ScreenShell title="Brief">
      <section className="panel-etch p-5 font-[family-name:var(--font-mono)] text-sm leading-relaxed whitespace-pre-wrap text-[var(--chrome)]">
        {text}
      </section>
    </ScreenShell>
  );
}
