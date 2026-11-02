/**
 * A SUSPENDED PLAYBACK CONTEXT IS A SILENT CALL.
 *
 * Classic, 2026-10-04: "she is not speaking. we cannot hear her and her lips
 * are not synced." Both halves are ONE cause, and this module exists to make
 * that cause impossible to ship again silently.
 *
 * WHAT GOES WRONG. useVoiceCall's connect() bounds the playback `resume()` at
 * RESUME_TIMEOUT_MS so a queued resume can never wedge the call in
 * "connecting" — correct, and deliberately allowed to expire. What was missing
 * was any check of the OUTCOME. By the time connect() creates the playback
 * context, the click that started the call has already been spent on
 * /api/realtime + getUserMedia + audioWorklet.addModule (useVoiceCall.ts
 * documents exactly this at :3179-3182), so under the browser's autoplay
 * policy `resume()` can still be queued. If the context never reaches
 * "running":
 *
 *   - every buffer schedulePlayback enqueues sits unplayed          -> INAUDIBLE
 *   - ctx.currentTime is FROZEN, so the mouth clock computes
 *     played = turnAudioMs - (nextStart - currentTime) <= 0 all turn -> UNSYNCED
 *
 * and because the analyser envelope is a MULTIPLIER on the mouth shape, an
 * inaudible her cannot move her lips at all. One root cause, both symptoms.
 *
 * WHY THIS IS ITS OWN MODULE AND NOT A CLOSURE IN THE HOOK. Nothing in
 * tests/ asserted audibility — the string "destination" appears in ZERO test
 * files, and the "never silent" suite is regex over source text, so a fully
 * green 1964-test suite was compatible with total silence. Logic living inside
 * a React hook can only be checked that way. Here it is a plain function over
 * injected seams, so tests/call-playback-audible.test.ts can EXERCISE it:
 * suspend a context, fire a gesture, assert she became audible.
 */

/** The minimum of AudioContext this module needs. */
export interface AudibleContext {
  readonly state: AudioContextState | string;
  resume?: () => unknown;
}

export interface PlaybackUnblockSeams {
  /** The live context, re-read on every gesture — never captured once. */
  getContext: () => AudibleContext | null;
  /** Resume without assuming resume() returns a promise (older WebKit form). */
  resume: (ctx: AudibleContext) => void;
  /** Register a gesture handler; returns the detach for it. */
  armGesture: (handler: () => void) => () => void;
  /** Called at most once per call, only when she is STILL blocked. */
  report: (kind: "blocked" | "recovered") => void;
  /** Deferred liveness check. Returns a cancel handle. */
  defer: (fn: () => void, ms: number) => () => void;
  /** Grace before a still-suspended context is reported as blocked. */
  graceMs: number;
}

export interface PlaybackUnblockHandle {
  /** True when the context was not running and recovery was armed. */
  readonly armed: boolean;
  /** Tear down listeners and timers. Idempotent. */
  dispose: () => void;
}

/**
 * Ensure `ctx` is audible, and arm self-recovery when it is not.
 *
 * Returns immediately with `armed: false` when the context is already running —
 * the overwhelmingly common case, and the reason this is safe to call on every
 * audio frame.
 *
 * DOES NOT REPORT SYNCHRONOUSLY. `resume()` is asynchronous, so the state
 * cannot have flipped yet; reporting here would raise an ALERT on every healthy
 * call whose resume lands a few milliseconds late. The report is owned by the
 * deferred liveness check, which speaks only if she is still blocked after a
 * resume has had time to take — the only case he needs to see.
 */
export function ensureAudible(
  ctx: AudibleContext,
  seams: PlaybackUnblockSeams,
): PlaybackUnblockHandle {
  if (ctx.state === "running") {
    return { armed: false, dispose: () => {} };
  }

  // One cheap, idempotent attempt right now.
  try {
    seams.resume(ctx);
  } catch {
    /* resuming must never be the reason the call breaks */
  }

  let disposed = false;
  let reported = false;
  let detachGesture: (() => void) | null = null;
  let cancelDefer: (() => void) | null = null;

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      detachGesture?.();
    } catch {
      /* ignore */
    }
    detachGesture = null;
    try {
      cancelDefer?.();
    } catch {
      /* ignore */
    }
    cancelDefer = null;
  };

  // A real gesture is the autoplay policy's own unlock condition, so his next
  // click or keypress anywhere on the deck brings her voice through.
  const onGesture = (): void => {
    if (disposed) return;
    const live = seams.getContext();
    if (!live) {
      dispose();
      return;
    }
    try {
      seams.resume(live);
    } catch {
      /* ignore */
    }
    if (live.state === "running") {
      if (reported) seams.report("recovered");
      dispose();
    }
  };

  try {
    detachGesture = seams.armGesture(onGesture);
  } catch {
    detachGesture = null;
  }

  cancelDefer = seams.defer(() => {
    cancelDefer = null;
    if (disposed) return;
    const live = seams.getContext();
    if (!live || live.state === "running") {
      dispose(); // resolved itself — stay quiet
      return;
    }
    if (reported) return;
    reported = true;
    seams.report("blocked");
  }, seams.graceMs);

  return {
    get armed() {
      return !disposed;
    },
    dispose,
  };
}
