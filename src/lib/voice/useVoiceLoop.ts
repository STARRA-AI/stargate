"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useStargate } from "@/lib/stargate-context";
import { COPY } from "@/lib/copy";
import {
  getWakeWordEnabled,
  matchWakeWord,
  setWakeWordEnabled,
} from "@/lib/voice/wake-word";

type RecogResultEvent = {
  results: { 0: { transcript: string }; isFinal?: boolean }[];
  resultIndex?: number;
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
  stop: () => void;
  abort?: () => void;
};

function getSR(): (new () => Recog) | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: new () => Recog;
    webkitSpeechRecognition?: new () => Recog;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/**
 * Voice loop: say "starra" (wake word) or ⌥+Space / badge tap.
 * Realtime session when keyed; Web Speech STT + Piper/Web Speech TTS otherwise.
 */
export function useVoiceLoop() {
  const { setHudState, setLastReply, pushLog, hudState } = useStargate();
  const speakingRef = useRef(false);
  const abortSpeak = useRef<AbortController | null>(null);
  const sessionActive = useRef(false);
  const wakeRecogRef = useRef<Recog | null>(null);
  const commandRecogRef = useRef<Recog | null>(null);
  const [wakeWordOn, setWakeWordOn] = useState(true);

  useEffect(() => {
    setWakeWordOn(getWakeWordEnabled());
    function onPref(e: Event) {
      const detail = (e as CustomEvent<{ on: boolean }>).detail;
      if (typeof detail?.on === "boolean") setWakeWordOn(detail.on);
      else setWakeWordOn(getWakeWordEnabled());
    }
    window.addEventListener("stargate-wake-word", onPref);
    return () => window.removeEventListener("stargate-wake-word", onPref);
  }, []);

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
      sessionActive.current = true;
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
          sessionActive.current = false;
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
      } finally {
        sessionActive.current = false;
      }
    },
    [pushLog, setHudState, setLastReply, speak],
  );

  const stopWakeListener = useCallback(() => {
    try {
      wakeRecogRef.current?.abort?.();
      wakeRecogRef.current?.stop();
    } catch {
      /* ignore */
    }
    wakeRecogRef.current = null;
  }, []);

  const wake = useCallback(async () => {
    if (speakingRef.current || hudState === "speaking") {
      stopSpeaking();
    }

    stopWakeListener();
    sessionActive.current = true;
    setHudState("wake");
    pushLog("wake");

    await fetch("/api/realtime", { method: "POST" })
      .then((r) => r.json())
      .catch(() => ({ mode: "stub" }));

    const SR = getSR();
    if (!SR) {
      setHudState("idle");
      setLastReply(COPY.voiceUnavailable);
      pushLog("voice unavailable");
      sessionActive.current = false;
      return;
    }

    try {
      commandRecogRef.current?.abort?.();
      commandRecogRef.current?.stop();
    } catch {
      /* ignore */
    }

    const recog = new SR();
    commandRecogRef.current = recog;
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
      else sessionActive.current = false;
    };
    recog.onerror = () => {
      setHudState("error");
      sessionActive.current = false;
      setTimeout(() => setHudState("idle"), 800);
    };
    recog.onend = () => {
      if (!speakingRef.current && hudState !== "thinking" && hudState !== "streaming") {
        /* leave state machine to sendToChat / speak */
      }
      commandRecogRef.current = null;
    };

    try {
      recog.start();
    } catch {
      setHudState("idle");
      sessionActive.current = false;
    }
  }, [
    hudState,
    pushLog,
    sendToChat,
    setHudState,
    setLastReply,
    stopSpeaking,
    stopWakeListener,
  ]);

  const startWakeListener = useCallback(() => {
    if (!getWakeWordEnabled()) return;
    if (sessionActive.current) return;
    if (speakingRef.current) return;
    if (wakeRecogRef.current) return;

    const SR = getSR();
    if (!SR) return;

    const recog = new SR();
    wakeRecogRef.current = recog;
    recog.continuous = true;
    recog.interimResults = false;
    recog.lang = "en-US";

    recog.onresult = (ev) => {
      const idx = ev.resultIndex ?? ev.results.length - 1;
      const row = ev.results[idx];
      const text = row?.[0]?.transcript ?? "";
      if (!text) return;
      const { woke, command } = matchWakeWord(text);
      if (!woke) return;

      pushLog("wake word");
      stopWakeListener();

      if (command) {
        void sendToChat(command);
      } else {
        void wake();
      }
    };

    recog.onerror = () => {
      wakeRecogRef.current = null;
    };

    recog.onend = () => {
      wakeRecogRef.current = null;
      // Restart if still idle + enabled
      if (
        getWakeWordEnabled() &&
        !sessionActive.current &&
        !speakingRef.current
      ) {
        window.setTimeout(() => startWakeListener(), 400);
      }
    };

    try {
      recog.start();
    } catch {
      wakeRecogRef.current = null;
    }
  }, [pushLog, sendToChat, stopWakeListener, wake]);

  // Hotkey ⌥+Space
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

  // Wake-word loop when idle
  useEffect(() => {
    const busy =
      hudState === "wake" ||
      hudState === "listening" ||
      hudState === "transcribing" ||
      hudState === "thinking" ||
      hudState === "streaming" ||
      hudState === "speaking" ||
      hudState === "tool";

    if (!wakeWordOn || busy) {
      stopWakeListener();
      return;
    }

    const t = window.setTimeout(() => startWakeListener(), 500);
    return () => {
      window.clearTimeout(t);
    };
  }, [hudState, wakeWordOn, startWakeListener, stopWakeListener]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopWakeListener();
      try {
        commandRecogRef.current?.abort?.();
        commandRecogRef.current?.stop();
      } catch {
        /* ignore */
      }
    };
  }, [stopWakeListener]);

  const setWakeWord = useCallback(
    (on: boolean) => {
      setWakeWordEnabled(on);
      setWakeWordOn(on);
      if (!on) stopWakeListener();
      else if (hudState === "idle") startWakeListener();
      pushLog(on ? "wake word on" : "wake word off");
    },
    [hudState, pushLog, startWakeListener, stopWakeListener],
  );

  return { wake, stopSpeaking, wakeWordOn, setWakeWord };
}
