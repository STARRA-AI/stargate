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
 *
 * Chat turns (fetch + history commit + TTS) are NOT owned here — they run
 * through the shared `sendMessage` in stargate-context.tsx, the same entry
 * point DeckConsole's typed chat uses. That keeps one transcript and one HUD
 * state machine for both input modes, and means barge-in only has to
 * interrupt a single in-flight turn (see `stopSpeaking` below) instead of
 * juggling two independent abort paths.
 */
export function useVoiceLoop() {
  const { setHudState, setLastReply, pushLog, hudState, sendMessage, stopSpeaking } =
    useStargate();
  const sessionActive = useRef(false);
  const wakeRecogRef = useRef<Recog | null>(null);
  const commandRecogRef = useRef<Recog | null>(null);
  const [wakeWordOn, setWakeWordOn] = useState(true);

  // Always-fresh read of hudState inside recognition event handlers, which
  // are set once per recog instance and would otherwise close over a stale
  // value.
  const hudStateRef = useRef(hudState);
  useEffect(() => {
    hudStateRef.current = hudState;
  }, [hudState]);

  // Guards sendToChat's `finally` against resetting sessionActive after a
  // newer barge-in has already claimed it (see wake()).
  const turnIdRef = useRef(0);

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

  const sendToChat = useCallback(
    async (text: string) => {
      const myTurn = ++turnIdRef.current;
      sessionActive.current = true;
      try {
        await sendMessage(text);
      } finally {
        // Only clear session state for the turn we started — a barge-in
        // (wake()) that interrupted us already bumped turnIdRef and owns
        // sessionActive from here.
        if (turnIdRef.current === myTurn) {
          sessionActive.current = false;
        }
      }
    },
    [sendMessage],
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
    // Barge-in: cleanly interrupt any in-flight turn (thinking / streaming /
    // speaking) before taking the mic. Invalidate the turn token first so a
    // stale sendToChat's `finally` can't clobber sessionActive/HUD once we
    // start listening again.
    turnIdRef.current++;
    stopSpeaking();

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

    // Set once a real result kicks off a chat turn — tells onend whether it
    // needs to reset state itself (no result / silence / timeout) or leave
    // it to sendToChat's own lifecycle.
    let turnStarted = false;

    recog.onstart = () => setHudState("listening");
    recog.onspeechstart = () => {
      // Defensive: cut off stale speech if it's somehow still playing once
      // the command recognizer picks up the operator talking.
      if (hudStateRef.current === "speaking") stopSpeaking();
    };
    recog.onresult = (ev) => {
      const text = ev.results[0]?.[0]?.transcript ?? "";
      if (text) {
        turnStarted = true;
        setHudState("transcribing");
        void sendToChat(text);
      } else {
        sessionActive.current = false;
        setHudState("idle");
      }
    };
    recog.onerror = () => {
      setHudState("error");
      sessionActive.current = false;
      setTimeout(() => setHudState("idle"), 800);
    };
    recog.onend = () => {
      commandRecogRef.current = null;
      // A recognition can end with no onresult and no onerror (silence,
      // platform timeout, etc.) — without this the loop freezes forever at
      // "listening"/"wake" since nothing else would ever move HUD state or
      // sessionActive forward.
      if (!turnStarted && sessionActive.current) {
        sessionActive.current = false;
        setHudState("idle");
      }
    };

    try {
      recog.start();
    } catch {
      setHudState("idle");
      sessionActive.current = false;
    }
  }, [pushLog, sendToChat, setHudState, setLastReply, stopSpeaking, stopWakeListener]);

  const startWakeListener = useCallback(() => {
    if (!getWakeWordEnabled()) return;
    if (sessionActive.current) return;
    if (hudStateRef.current === "speaking") return;
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
      if (getWakeWordEnabled() && !sessionActive.current) {
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
