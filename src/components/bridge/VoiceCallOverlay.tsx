"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVoiceCall, type VoiceCallState } from "@/lib/voice/useVoiceCall";
import {
  usePrivateCall,
  callEngineNote,
  privateStatusCopy,
  toCallFaceState,
} from "@/lib/voice/usePrivateCall";
import {
  getCallEngine,
  setCallEngine,
  type CallEngine,
} from "@/lib/voice/deck-prefs";
import {
  StarraClipFace,
  selectFaceAnalyser,
  selectFaceMode,
} from "./StarraClipFace";
import { StarraCallChat } from "./StarraCallChat";
import { useStargateStream } from "@/lib/stargate-context";
import { parseMcpCommand } from "@/lib/mcp/commands";
import { isCodeAsk } from "@/lib/voice/code-speech";
import { decideSpicy, pickSpicyClip } from "@/lib/voice/spicy-mode";
// ENGINE BUS — client-safe, secret-free. "@/lib/engine/bus" only.
import { publishCallLive, useEngineBus } from "@/lib/engine/bus";

// INTEGRATION NOTE (contract §8, A1↔A2 seam): A1's half is landed, so this
// file consumes the seam directly with no casts —
//   `analyser: AnalyserNode | null` on UseVoiceCallResult (useVoiceCall.ts:120)
//   `analyser?: AnalyserNode | null` on StarraClipFace's props
//   (StarraClipFace.tsx:57)
// The earlier landing-order shims (a widened ReturnType intersection and an
// `as unknown as ComponentType<…>` on StarraClipFace) are deleted: they are
// not just redundant, they SUPPRESS type-checking across the one cross-agent
// seam the contract requires be checked. `analyser` being null stays a normal
// state — StarraClipFace renders today's exact behavior when it is null.

/**
 * LIVE CALL COLUMN — Bug 2 fix. Every new call used to open showing the whole
 * prior conversation because `chatMessages` prepended `history` (the
 * PERSISTENT deck chat from useStargateStream, folded back in by
 * resyncHistory() on close — see the effect at :156-159) ahead of this call's
 * own `transcript`. Classic's words: "every call starts with a FRESH log."
 * The fix is to render ONLY the live call's transcript here — old
 * conversations move behind an explicit "Past conversations" control (Bug 3),
 * they never silently prefill this column.
 *
 * Pure + exported so the contract is provable without a DOM
 * (tests/call-chat-fresh.test.ts): an empty transcript composes to an empty
 * list no matter how much deck history exists.
 */
export function composeCallChatMessages(
  transcript: { role: "user" | "assistant"; text: string }[],
): { role: "user" | "assistant"; text: string }[] {
  return transcript.map((m) => ({ role: m.role, text: m.text }));
}

function statusCopy(state: VoiceCallState): string {
  switch (state) {
    case "listening":
      return "Listening…";
    case "speaking":
      return "STARRA is speaking…";
    case "reconnecting":
      return "Reconnecting…";
    case "error":
      return "Voice link down.";
    case "connecting":
    case "idle":
    default:
      return "Connecting…";
  }
}

/** True when connect()'s surfaced error is the "no xAI key linked" stub-mode
 * message from /api/realtime (its stub copy reads "...link the xAI key in
 * Settings → Link APIs"). The mic-blocked message deliberately says "System
 * Preferences", not "Settings", so it never matches here. */
function pointsToSettings(message: string): boolean {
  return /settings/i.test(message);
}

/**
 * FaceTime-style full-screen voice call with STARRA. Her face fills the screen;
 * it switches clips on call state (idle ⇄ attentive-listening ⇄ talking). No
 * transcript — just her, like a real call. All call/audio plumbing lives in
 * useVoiceCall(); this drives connect()/disconnect() off the `open` prop and
 * renders the engine's state.
 */
export function VoiceCallOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  // BOTH engines are constructed on every render — hooks cannot be conditional,
  // and neither of these does ANYTHING until its connect() is called. The
  // hosted engine's behaviour is therefore unchanged by the private one's
  // presence: no socket, no mic, no token, no timer starts from construction.
  const {
    state: hostedState,
    error: hostedError,
    transcript: hostedTranscript,
    liveUser: hostedLiveUser,
    liveAssistant: hostedLiveAssistant,
    connect: hostedConnect,
    disconnect: hostedDisconnect,
    muted: hostedMuted,
    toggleMute: hostedToggleMute,
    lipSyncClip,
    lipSyncRendering,
    clearLipSyncClip,
    analyser: hostedAnalyser,
    sendText,
  } = useVoiceCall();
  const priv = usePrivateCall();

  // ── ENGINE CHOICE ────────────────────────────────────────────────────────
  // `engine` is what he picked; `activeEngine` is what the LIVE call is running
  // on. They are two values on purpose: the live call's engine is captured at
  // connect and never changes under it (no mid-call swaps in V1), so flipping
  // the selector mid-call sets the NEXT call's engine and says so in the note.
  //
  // The selector is deliberately NOT disabled while the call is up. Disabling
  // it would make it unreachable in practice — this overlay connects the moment
  // it opens, so there is no window in which a disabled control could be
  // operated at all. Immutability is enforced where it actually matters (the
  // captured activeEngine), not by a button nobody can ever press.
  //
  // DEFAULT "normal", read AFTER mount: getCallEngine touches localStorage, and
  // seeding useState from it would make the server-rendered markup disagree with
  // the client's first paint.
  const [engine, setEngine] = useState<CallEngine>("normal");
  const [activeEngine, setActiveEngine] = useState<CallEngine>("normal");
  useEffect(() => {
    setEngine(getCallEngine());
  }, []);
  const chooseEngine = useCallback((next: CallEngine) => {
    setEngine(next);
    setCallEngine(next);
  }, []);

  const isPrivate = activeEngine === "private";
  // Everything below this line reads ONE engine's surface. The private engine's
  // extra states collapse to the shared union through toCallFaceState, so the
  // face, the ringback and the focus trap need no branch of their own.
  const state: VoiceCallState = isPrivate
    ? toCallFaceState(priv.state)
    : hostedState;
  const error = isPrivate ? priv.error : hostedError;
  const transcript = isPrivate ? priv.transcript : hostedTranscript;
  const liveUser = isPrivate ? priv.liveUser : hostedLiveUser;
  const liveAssistant = isPrivate ? priv.liveAssistant : hostedLiveAssistant;
  const muted = isPrivate ? priv.muted : hostedMuted;
  const toggleMute = isPrivate ? priv.toggleMute : hostedToggleMute;
  const analyser = isPrivate ? priv.analyser : hostedAnalyser;
  const connect = isPrivate ? priv.connect : hostedConnect;
  const disconnect = isPrivate ? priv.disconnect : hostedDisconnect;

  const panelRef = useRef<HTMLDivElement>(null);
  const endBtnRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const ringbackRef = useRef<HTMLAudioElement>(null);

  // Shared brain stream — the fallback answer path when no live call can
  // carry a typed message. `history` (the persistent deck chat) is deliberately
  // NOT read into the live column any more (Bug 2, see composeCallChatMessages
  // above) — resyncHistory() below still folds the call's turns INTO it once
  // the call closes, so the deck chat outside the call keeps remembering.
  const { streaming, sendMessage, resyncHistory, stopSpeaking } =
    useStargateStream();
  // ONE TRANSCRIPT: when the call closes, fold its recorded turns from the
  // shared store into the visible deck history — she "remembers" the call in
  // the chat column immediately, no reload.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (wasOpenRef.current && !open) void resyncHistory();
    wasOpenRef.current = open;
  }, [open, resyncHistory]);

  // ── SPICY MODE — her videos ON HER FACE, never a separate window ─────────
  // Classic arms it by saying/typing "spicy mode" on the call; asking her to
  // play one of her videos then swaps a clip onto the avatar stage itself
  // (streamed from the auth-gated /api/avatar/spicy route). Ends on the clip's
  // own `ended`, on "stop the video"/"back to you", or with the call. Pure
  // decisions live in src/lib/voice/spicy-mode.ts (tested); this block is only
  // the wiring. Classic-initiated only, per the locked persona clause.
  /**
   * COLLAPSED CALL (2026-08-21, Classic's ask: "i want it to be able to collapse
   * and be this size so that she can just be a small window if necessary. so
   * basically want both").
   *
   * ONE VIDEO SERVES BOTH SIZES. Expanded is her waist-up frame as filmed;
   * collapsed zooms the SAME layer to her head via a CSS transform on
   * `.call-face-portrait`. There is no second clip, no second render and no
   * source swap — so nothing can pop, and a collapsed call costs nothing extra.
   *
   * MUTE and END stay mounted and reachable while collapsed. Only the engine
   * selector and the chat pane hide. He must never be able to shrink himself
   * into a call he cannot end.
   */
  const [collapsed, setCollapsed] = useState(false);
  const [spicyArmed, setSpicyArmed] = useState(false);
  const [spicyClip, setSpicyClip] = useState<string | null>(null);
  const spicyArmedRef = useRef(false);
  spicyArmedRef.current = spicyArmed;
  const spicyListRef = useRef<string[] | null>(null);
  const spicyLastRef = useRef<string | null>(null);
  const spicySeenRef = useRef(0);
  useEffect(() => {
    if (!open) {
      // A new call starts cold: spicy mode never carries across calls.
      setSpicyArmed(false);
      setSpicyClip(null);
      spicySeenRef.current = 0;
      return;
    }
    // Only the newest not-yet-processed USER line can decide anything.
    for (let i = spicySeenRef.current; i < transcript.length; i++) {
      const line = transcript[i];
      if (line.role !== "user") continue;
      const d = decideSpicy(line.text, spicyArmedRef.current);
      if (d.armed !== spicyArmedRef.current) setSpicyArmed(d.armed);
      spicyArmedRef.current = d.armed;
      if (d.action === "stop") setSpicyClip(null);
      if (d.action === "play") {
        void (async () => {
          try {
            if (!spicyListRef.current) {
              const r = await fetch("/api/avatar/spicy");
              const j = r.ok
                ? ((await r.json()) as { clips?: string[] })
                : null;
              spicyListRef.current = Array.isArray(j?.clips) ? j.clips : [];
            }
            const pick = pickSpicyClip(
              spicyListRef.current,
              Math.random(),
              spicyLastRef.current,
            );
            if (pick) {
              spicyLastRef.current = pick;
              setSpicyClip(pick);
            }
          } catch {
            /* no list, no clip — the face just stays live */
          }
        })();
      }
    }
    spicySeenRef.current = transcript.length;
  }, [open, transcript]);
  // ONE VOICE (Classic's order, 2026-07-30): while her call is LIVE, typing to
  // her goes INTO the call — the same realtime session answers aloud as eve,
  // same persona, same context. Only when no open call can carry it does the
  // brain+TTS path answer instead.
  const handleSend = useCallback(
    (t: string) => {
      // PRIVATE CALL — FIRST, and unconditionally. Every branch below this one
      // ends at sendMessage with the text UNPREFIXED, which is the hosted brain.
      // On a private call that is precisely the leak the lane exists to
      // prevent, so the private branch cannot sit anywhere but the top: prefix
      // the ask (unless he already typed it) and let the deck's own private
      // lane answer it locally, text-only under the call's voice claim.
      if (isPrivate) {
        const already = /^\s*private\b/i.test(t);
        void sendMessage(already ? t : `private ${t}`);
        return;
      }
      // TOOLS ON THE CALL (2026-07-31): `mcp tools` / `browse <url>` /
      // `mcp <server> <tool>` are BRAIN work — the realtime session cannot run
      // them. Route tool commands to the brain path even mid-call (the result
      // lands in this same column and she can talk it through); everything
      // else rides the live call as before. TEXT-ONLY while the call is live:
      // speakStarra's callLive gate keeps her call voice the only voice.
      if (parseMcpCommand(t)) {
        void sendMessage(t);
        return;
      }
      // CODE ON THE CALL (2026-08-04): a typed code ask is BRAIN work for the
      // same reason tools are — the realtime session answers in AUDIO, and an
      // audio stream cannot carry a fenced, copyable block. The brain's reply
      // streams into this same column with the code sectioned off
      // (markdown.tsx CodeBlock) — SILENTLY while the call is live
      // (speakStarra's callLive gate): the double-voice incident of 2026-08-04
      // was this very path speaking its prose over her live call voice.
      if (isCodeAsk(t)) {
        void sendMessage(t);
        return;
      }
      if (sendText(t)) return;
      void sendMessage(t);
    },
    [isPrivate, sendText, sendMessage],
  );
  // TEXT truth: still the right signal for the chat column's busy state.
  const sheReplying = streaming.trim().length > 0;

  // AUDIO truth: what her voice is actually doing. This is deliberately NOT
  // derived from `streaming`.
  //
  // THE BUG THIS FIXES: `faceMode` used to be `state === "speaking" ||
  // sheReplying`, i.e. driven by the TEXT token stream. stargate-context.tsx
  // calls setStreaming("") BEFORE awaiting the TTS round-trip and
  // therefore before audio.play() — so her face animated all the way through the
  // SILENT token stream and flipped back to the idle pool at the exact moment
  // her voice started. Inverted, every single typed reply.
  //
  // speak.ts publishes `playing` from the audio element's own `playing`/`ended`/
  // `pause`/`error` events (and clears it on every failure path), so it cannot
  // latch on when TTS fails. It also hands over an analyser on her TTS output —
  // the typed-reply path previously had none at all, which pinned openness at 0.
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [ttsAnalyser, setTtsAnalyser] = useState<AnalyserNode | null>(null);
  // ENGINE BUS — the aggregated truth. speak.ts publishes the TTS leg from the
  // audio element's own events; useVoiceCall publishes the realtime leg with the
  // analyser it already creates. Reading it HERE is what stops this component
  // guessing on its own: `faceMode` and the mouth's analyser now come from the
  // same place, whichever surface is actually making sound.
  //
  // ADDITIVE, NOT AUTHORITATIVE. Both selectors below fall back to the exact
  // pre-bus expressions when the bus is silent, and the bus can only ADD a
  // speaking face, never subtract one. The direct subscription above is kept
  // deliberately: it is what gates speak.ts's WebAudio tap on `open`
  // (its `ttsListeners.size === 0` bail), so it is load-bearing for her voice —
  // and it is the belt if the bus ever went quiet.
  const bus = useEngineBus();
  //
  // GATED ON `open` DELIBERATELY, and this is load-bearing for her VOICE, not
  // just tidiness. speak.ts only builds an AudioContext / captures her TTS
  // element into a WebAudio graph when this subscription exists (its
  // `ttsListeners.size === 0` bail). This component is mounted for the whole
  // session (Bridge.tsx:645 mobile, :1238 desktop) and returns null closed, so an
  // ungated `[]` subscription made every typed DeckConsole reply and every
  // wake-word reply carry the WebAudio risk while nothing on screen could
  // possibly use the analyser — StarraClipFace is its only consumer and only
  // renders inside this overlay. Closing the call now really does switch the tap
  // off. Re-opening re-reads current truth via getTtsAudio() below.
  useEffect(() => {
    if (typeof window === "undefined" || !open) return;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    // Dynamic import matches how stargate-context.tsx reaches speak.ts, keeping
    // the voice module off the SSR path.
    void import("@/lib/voice/speak")
      .then(({ subscribeTtsAudio, getTtsAudio }) => {
        if (cancelled) return;
        const apply = (s: { playing: boolean; analyser: AnalyserNode | null }) => {
          setTtsPlaying(s.playing);
          setTtsAnalyser(s.analyser);
        };
        apply(getTtsAudio()); // catch a reply already in flight
        unsubscribe = subscribeTtsAudio(apply);
      })
      .catch(() => {
        /* no audio truth available — falls back to call state below */
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
      // Nothing is listening any more, so this state can only go stale. Drop it
      // to the safe default (idle face, no analyser) rather than letting a
      // re-opened call paint one frame of a speaking face from a finished turn.
      setTtsPlaying(false);
      setTtsAnalyser(null);
    };
  }, [open]);

  // One call, one fresh log: this call's own transcript only (Bug 2). See
  // composeCallChatMessages above for why `history` is no longer folded in
  // here.
  const chatMessages = useMemo(
    () => composeCallChatMessages(transcript),
    [transcript],
  );

  // Mirror connect/disconnect in refs so the open/close effect reacts only to
  // `open` itself, not to callback identity churn as the engine advances
  // through its states — reacting to that churn would tear the call down.
  //
  // ONE REF PER ENGINE, not one for the selected engine: the open effect
  // CAPTURES the choice and then dials, and at that instant `activeEngine` has
  // not re-rendered yet — a ref holding the derived callback would still point
  // at the engine we are switching away from.
  const hostedConnectRef = useRef(hostedConnect);
  const hostedDisconnectRef = useRef(hostedDisconnect);
  const privConnectRef = useRef(priv.connect);
  const privDisconnectRef = useRef(priv.disconnect);
  useEffect(() => {
    hostedConnectRef.current = hostedConnect;
  }, [hostedConnect]);
  useEffect(() => {
    hostedDisconnectRef.current = hostedDisconnect;
  }, [hostedDisconnect]);
  useEffect(() => {
    privConnectRef.current = priv.connect;
  }, [priv.connect]);
  useEffect(() => {
    privDisconnectRef.current = priv.disconnect;
  }, [priv.disconnect]);

  /** Hang up BOTH engines. Each is a no-op when it was never dialled, so this
   * is always safe and removes any way for a swap to strand a live mic. */
  const hangUpBoth = useCallback(() => {
    hostedDisconnectRef.current();
    privDisconnectRef.current();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return; // SSR: nothing to connect to
    if (open) {
      // ONE VOICE — THE CALL'S (Classic's order, 2026-08-04): claim her voice
      // for the call BEFORE the line even connects, and cut off any chat TTS
      // turn already speaking — a brain reply mid-sentence must not keep
      // talking under the ringback or over the live call. The claim is what
      // speakStarra's callLive gate reads, so from this moment until close no
      // chat-side engine can make a sound.
      publishCallLive(true);
      // `body.in-call` (the deck-suspend class) is NOT set here. It belongs to
      // the dedicated effect below, because it must follow `collapsed` as well
      // as `open` — see the comment there.
      stopSpeaking();
      // THE LOCK: the engine is captured here and held for the whole call.
      //
      // Read from localStorage, NOT from this component's state (fix wave).
      // getCallEngine IS the source of truth and chooseEngine writes it
      // synchronously before the render lands, so this is never staler than the
      // state — and it does not depend on this overlay having been mounted long
      // enough for the after-mount read to have run. Today it always is
      // (Bridge.tsx keeps it mounted and returns null when closed), but that is
      // a property of a DIFFERENT file: if anyone ever mounts this overlay
      // conditionally, reading state here would silently dial NORMAL on the
      // first call of every session.
      const chosen = getCallEngine();
      setEngine(chosen);
      setActiveEngine(chosen);
      if (chosen === "private") void privConnectRef.current();
      else void hostedConnectRef.current();
    } else {
      publishCallLive(false);
      hangUpBoth();
    }
  }, [open, stopSpeaking, hangUpBoth]);

  // ── SUSPEND THE DECK ONLY WHILE THE CALL ACTUALLY COVERS IT ──────────────
  // `body.in-call` stills the deck's decorative motion (deck.css) and stops
  // LiveSky's and ReactorSphere's rAF loops outright. That is only correct while
  // the call is EXPANDED, because only then does `.call-facetime` paint opaque
  // --void over the whole viewport (deck.css:1378-1383).
  //
  // COLLAPSED, the call is a 268px window in the bottom-right corner
  // (deck.css:1574-1578) and the deck is in full view. Keying this class on
  // `open` alone froze the exact screen he collapses the call in order to keep
  // working on — so it is keyed on `open && !collapsed`.
  //
  // No other plumbing is needed: LiveSky's MutationObserver (LiveSky.tsx:359-360)
  // and ReactorSphere's (ReactorSphere.tsx:193-194) both watch body's class
  // attribute and re-sync, so collapse and expand each recover on their own.
  //
  // THE DECK MUST ALWAYS COME BACK. The cleanup runs on every change of either
  // flag and on unmount, so an error path, a thrown connect or a hot reload
  // cannot leave the deck frozen behind a closed call.
  useEffect(() => {
    const coversTheDeck = open && !collapsed;
    document.body.classList.toggle("in-call", coversTheDeck);
    return () => document.body.classList.remove("in-call");
  }, [open, collapsed]);

  // Belt-and-suspenders: tear the engine down (and release her voice) if this
  // unmounts mid-call.
  useEffect(() => {
    return () => {
      publishCallLive(false);
      document.body.classList.remove("in-call");
      hangUpBoth();
    };
  }, [hangUpBoth]);

  // Ringback: her song plays EXACTLY ONCE per summon — on the first connect —
  // then fades out when she picks up. It never replays on a reconnect and never
  // loops; it only plays again when the call is closed and re-summoned (the
  // ringbackDoneRef resets when `open` goes false, below).
  const ringbackDoneRef = useRef(false);
  // The fade is also once-per-summon. Without this latch, EVERY listening⇄speaking
  // transition (many per call) started a fresh 600ms requestAnimationFrame loop on
  // an already-silent, already-paused element — ~36 needless frames per turn, each
  // one re-pausing the ringback and re-seeking it to 0, for the life of the call.
  const ringbackFadedRef = useRef(false);
  useEffect(() => {
    const a = ringbackRef.current;
    if (!a) return;
    const opening = state === "connecting" || state === "idle";
    if (opening && !ringbackDoneRef.current) {
      ringbackDoneRef.current = true; // one play per summon — reconnects won't replay
      a.volume = 0.35;
      a.currentTime = 0;
      void a.play().catch(() => {});
    } else if (
      (state === "listening" || state === "speaking") &&
      !ringbackFadedRef.current
    ) {
      ringbackFadedRef.current = true;
      // she picked up — fade the song out over ~600ms, then stop
      const start = a.volume;
      const t0 = typeof performance !== "undefined" ? performance.now() : 0;
      const fade = () => {
        const el = ringbackRef.current;
        if (!el) return;
        const p = Math.min(1, ((typeof performance !== "undefined" ? performance.now() : 0) - t0) / 600);
        el.volume = start * (1 - p);
        if (p < 1) requestAnimationFrame(fade);
        else { el.pause(); el.currentTime = 0; }
      };
      requestAnimationFrame(fade);
    }
  }, [state]);

  // Reset the one-play latch + stop the song when the call closes, so re-summoning
  // plays it fresh (once).
  useEffect(() => {
    if (!open) {
      ringbackDoneRef.current = false;
      ringbackFadedRef.current = false;
      const a = ringbackRef.current;
      if (a) { a.pause(); a.currentTime = 0; }
    }
  }, [open]);

  // (Her face no longer scales with live amplitude — that per-frame jitter was
  // part of the "seizure" look. She holds still + breathes gently; the speaking
  // glow is a slow calm CSS pulse.)

  // Focus management: move focus into the call on open, trap Tab, restore on
  // close. aria-modal is only a hint — the browser enforces none of this.
  useEffect(() => {
    if (typeof window === "undefined" || !open) return;

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => {
      (endBtnRef.current ?? panelRef.current)?.focus();
    }, 0);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocusedRef.current?.focus?.();
      previouslyFocusedRef.current = null;
    };
  }, [open]);

  const settingsLink = useMemo(
    () => (error && pointsToSettings(error) ? "/settings#link-apis" : null),
    [error],
  );

  if (!open) return null;

  function endCall() {
    disconnect();
    onClose();
  }

  // Which face clip is showing: her talking loop, her attentive-listening face,
  // or the calm idle (connecting / reconnecting / error all fall back to idle).
  // `ttsPlaying` (audio truth), NOT `sheReplying` (text truth) — see the
  // subscription above for why the text signal was inverted.
  // ONE TRUTH (see the bus notes above): `state` is the call leg, `ttsPlaying` is
  // the local TTS subscription, `bus.speaking` is whichever leg last reported real
  // sound. selectFaceMode is pure and unit-tested, and with the bus silent it
  // returns exactly what this expression returned before adoption.
  const faceMode = selectFaceMode({
    callState: state,
    ttsPlaying,
    busSpeaking: bus.speaking,
  });
  // The mouth's input, chosen once instead of by two surfaces independently.
  const faceAnalyser = selectFaceAnalyser({
    busSpeaking: bus.speaking,
    busAnalyser: bus.analyser,
    ttsPlaying,
    ttsAnalyser,
    callAnalyser: analyser,
  });
  const statusText =
    state === "error" && /microphone/i.test(error || "")
      ? "Microphone blocked"
      : lipSyncRendering
        ? "STARRA is putting her face on…"
        : isPrivate
          // The private engine has three states the shared union does not
          // (transcribing / thinking / speaking-locally), and collapsing them
          // into "Listening…" would leave him staring at a silent screen for
          // seconds with no idea which leg is working. Its own copy names the
          // leg. lipSyncRendering above is unreachable on this lane (that path
          // is hosted-only) and is left ahead of it untouched.
          ? privateStatusCopy(priv.state)
          : statusCopy(state);

  // The note under the selector: which engine the next call gets, and — on the
  // private lane — the honest "slower" warning while the measured turn is over
  // budget (or has never been measured). Pure, unit-tested.
  const engineNote = callEngineNote({
    chosen: engine,
    active: activeEngine,
    callLive: open,
    lastTurnMs: priv.lastTurnMs,
  });

  return (
    <div
      className={`call-overlay call-facetime${collapsed ? " is-collapsed" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="Voice call with STARRA"
      ref={panelRef}
      tabIndex={-1}
    >
      {/* Her song as the ringback while the line connects (fades out on pickup). */}
      <audio ref={ringbackRef} src="/avatar/starra-ringback.mp3" preload="auto" aria-hidden />

      {/* LEFT/CENTER: her face. RIGHT: the live transcript, beside her (her
          aspect ratio is untouched — the chat lives in its own column). */}
      <div className="call-face-col">
        <div className={`call-face-stage call-face-${faceMode}`}>
          {/* Lives INSIDE the stage on purpose: the stage is the one thing that
              stays on screen when collapsed, so the way back out is always
              visible. `.call-ft-controls` is hidden-by-parts, not wholesale. */}
          <button
            type="button"
            className="call-collapse-btn"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand call to full size" : "Collapse call to a small window"}
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? "EXPAND" : "COLLAPSE"}
          </button>
          <img className="call-face-backdrop" src="/avatar/starra-portrait.jpg" alt="" aria-hidden />
          {/* The HERO-FRAME backstop is NOT here. It has to live inside
              StarraClipFace's own `.call-face-portrait`, which is a stacking
              context — a backstop rendered as its sibling can never be seen
              through it. See the `.call-face-hero-still` comment in deck.css. */}
          {/* Her PHOTOREAL self from the real STARRA ANGLES clips, driven by call
              state (talking clip while she speaks; idle + expressions otherwise).
              `analyser` is the live output-audio analyser (null when she's not
              speaking / unavailable) — A1's free native-res mouth-patch renderer
              in StarraClipFace uses it to drive her mouth; omitting it (or it
              being null) must render exactly today's behavior (contract §8). */}
          {/* Whichever source is ACTUALLY making sound. Her TTS element wins while
              it is playing (a typed reply during a live call would otherwise be
              driven by the silent WS analyser); the call analyser is the default.
              Before this, typed replies had NO analyser on any graph at all, so
              openness read 0 for the whole reply and the bank's half-open floor
              frame sat frozen over her mouth. */}
          <StarraClipFace active={open} mode={faceMode} analyser={faceAnalyser} />
          {/* SPICY MODE clip — layered over the avatar INSIDE the same stage
              (Classic: "not in a separate window"). Tries sound first; if the
              engine refuses unmuted autoplay it retries muted rather than
              showing nothing. Unmounts on ended/stop/call-end. */}
          {spicyClip ? (
            <video
              key={spicyClip}
              src={`/api/avatar/spicy?clip=${encodeURIComponent(spicyClip)}`}
              autoPlay
              playsInline
              onEnded={() => setSpicyClip(null)}
              onError={() => setSpicyClip(null)}
              ref={(el) => {
                if (!el) return;
                el.muted = false;
                void el.play().catch(() => {
                  el.muted = true;
                  void el.play().catch(() => setSpicyClip(null));
                });
              }}
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                objectFit: "contain",
                background: "#000",
                zIndex: 5,
              }}
            />
          ) : null}
          {/* Paid Replicate fallback clip (flag-gated OFF via NEXT_PUBLIC_LIPSYNC=0,
              see lipsync.ts header): only rendered when lipSyncClip is non-null,
              which only ever happens if the flag is flipped on. When it IS wired,
              this is a 256x256 SadTalker crop letterboxed over her full-size face
              (`.call-face-lipsync` in deck.css) — that mismatch in scale is exactly
              the "pasted box" stiffness. The default today is A1's native-resolution
              mouth patch above, not this. */}
          {lipSyncClip ? (
            <video
              className="call-face-video call-face-lipsync"
              src={lipSyncClip}
              autoPlay
              playsInline
              onEnded={clearLipSyncClip}
              onError={clearLipSyncClip}
              style={{ opacity: 1, zIndex: 2 }}
            />
          ) : null}
          {/* speaking glow — a slow calm pulse while she talks (not amplitude) */}
          <div className="call-face-glow" aria-hidden />
          {/* readability scrim behind the top status + bottom controls */}
          <div className="call-face-scrim" aria-hidden />
        </div>

        <div className="call-ft-top">
          <span className="call-kicker">STARRA</span>
          <span
            className={`call-status${state === "error" ? " is-error" : ""}`}
            aria-live="polite"
          >
            {statusText}
          </span>
        </div>

        {state === "error" && error ? (
          <div className="call-error-box call-ft-error" role="alert">
            <span className="call-error-text">{error}</span>
            {settingsLink ? (
              <a className="call-error-link" href={settingsLink}>
                Open Settings → Link APIs
              </a>
            ) : null}
          </div>
        ) : null}

        <div className="call-ft-controls">
          {/* ENGINE SELECT — which STARRA answers this call. NORMAL is the
              hosted line she has always had; PRIVATE runs her ears, her brain
              and her voice entirely on this Mac. The live call keeps the engine
              it was dialled on; a change here takes the NEXT call (the note
              says so). Operator copy, dark tokens, no emojis. */}
          <div className="call-engine-select" role="group" aria-label="Call engine">
            <button
              type="button"
              className={`call-engine-btn${engine === "normal" ? " is-on" : ""}`}
              aria-pressed={engine === "normal"}
              onClick={() => chooseEngine("normal")}
            >
              NORMAL
            </button>
            <button
              type="button"
              className={`call-engine-btn${engine === "private" ? " is-on" : ""}`}
              aria-pressed={engine === "private"}
              onClick={() => chooseEngine("private")}
            >
              PRIVATE
            </button>
          </div>
          {engineNote ? (
            <span className="call-engine-note" aria-live="polite">
              {engineNote}
            </span>
          ) : null}

          <button
            type="button"
            className={`call-mute-btn${muted ? " is-muted" : ""}`}
            onClick={toggleMute}
            aria-pressed={muted}
          >
            {muted ? "UNMUTE" : "MUTE"}
          </button>

          {state === "error" ? (
            <button type="button" className="call-retry-btn" onClick={() => void connect()}>
              RETRY
            </button>
          ) : null}

          <button type="button" className="call-end-btn" onClick={endCall} ref={endBtnRef}>
            END CALL
          </button>
        </div>
      </div>

      {/* RIGHT: one conversation — type to her (Grok brain + memory), attach
          files, copy any line she says. Voice-call turns show here too. */}
      <aside className="call-chat-pane">
        <StarraCallChat
          messages={chatMessages}
          liveUser={liveUser}
          liveAssistant={streaming || liveAssistant}
          onSend={handleSend}
          busy={sheReplying}
        />
      </aside>
    </div>
  );
}
