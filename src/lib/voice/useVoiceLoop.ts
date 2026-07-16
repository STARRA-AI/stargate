"use client";

import { useCallback, useEffect, useRef } from "react";
import { useStargate } from "@/lib/stargate-context";
import { COPY } from "@/lib/copy";

type RecogResultEvent = {
  results: { 0: { transcript: string } }[];
};

type Recog = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: ((ev: Event) => void) | null;
  onspeechstart: ((ev: Event) => void) | null;
  onresult: ((ev: RecogResultEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onend: ((ev: Event) => void) | null;
  start: () => void;
};

/**
 * Voice loop: Option/Alt+Space wake; badge tap calls wake().
 * Realtime session when keyed; Web Speech STT + browser TTS otherwise.
 * Barge-in cancels TTS immediately on new speech.
 */
export function useVoiceLoop() {
  const { setHudState, setLastReply, pushLog, hudState } = useStargate();
  const speakingRef = useRef(false);
  const abortSpeak = useRef<AbortController | null>(null);

  const stopSpeaking = useCallback(() => {
    abortSpeak.current?.abort();
    void import("@/lib/voice/speak").then(({ stopAllSpeech }) => stopAllSpeech());
    speakingRef.current = false;
  }, []);

  const speak = useCallback(
    (text: string) => {
      if (typeof window === "undefined") return;
      stopSpeaking();
      const ac = new AbortController();
      abortSpeak.current = ac;
      speakingRef.current = true;
      setHudState("speaking");
      void import("@/lib/voice/speak").then(({ speakStarra }) =>
        speakStarra(text, ac.signal).then((engine) => {
          if (ac.signal.aborted || engine === "none") {
            if (!ac.signal.aborted && engine === "none") {
              speakingRef.current = false;
              setHudState("idle");
            }
            return;
          }
          speakingRef.current = false;
          setHudState("idle");
        }),
      );
    },
    [setHudState, stopSpeaking],
  );

  const sendToChat = useCallback(
    async (text: string) => {
      setHudState("thinking");
      pushLog(`voice: ${text.slice(0, 40)}`);
      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "user", content: text }],
          }),
        });
        if (!res.body) {
          setHudState("error");
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let full = "";
        setHudState("streaming");
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
        setLastReply(full);
        speak(full);
      } catch {
        setHudState("error");
        setLastReply(COPY.error);
      }
    },
    [pushLog, setHudState, setLastReply, speak],
  );

  const wake = useCallback(async () => {
    if (speakingRef.current || hudState === "speaking") {
      stopSpeaking();
    }

    setHudState("wake");
    pushLog("wake");

    await fetch("/api/realtime", { method: "POST" })
      .then((r) => r.json())
      .catch(() => ({ mode: "stub" }));

    const w = window as Window & {
      SpeechRecognition?: new () => Recog;
      webkitSpeechRecognition?: new () => Recog;
    };
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;

    if (!SR) {
      setHudState("idle");
      setLastReply(COPY.voiceUnavailable);
      pushLog("voice unavailable");
      return;
    }

    const recog = new SR();
    recog.continuous = false;
    recog.interimResults = false;
    recog.lang = "en-US";

    recog.onstart = () => setHudState("listening");
    recog.onspeechstart = () => {
      if (speakingRef.current) stopSpeaking();
    };
    recog.onresult = (ev) => {
      const text = ev.results[0]?.[0]?.transcript ?? "";
      setHudState("transcribing");
      if (text) void sendToChat(text);
    };
    recog.onerror = () => {
      setHudState("error");
      setTimeout(() => setHudState("idle"), 800);
    };
    recog.onend = () => {
      setHudState("idle");
    };

    try {
      recog.start();
    } catch {
      setHudState("idle");
    }
  }, [hudState, pushLog, sendToChat, setHudState, setLastReply, stopSpeaking]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code === "Space" && e.altKey) {
        e.preventDefault();
        void wake();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wake]);

  return { wake, stopSpeaking };
}
