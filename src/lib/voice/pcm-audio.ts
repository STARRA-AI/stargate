/**
 * PCM16 @ 24kHz helpers shared by useVoiceCall's mic-encode and
 * playback-decode paths for xAI's Realtime API (see api/realtime/route.ts).
 *
 * xAI expects/emits raw base64-encoded signed 16-bit little-endian PCM at a
 * fixed 24000Hz sample rate. The mic AudioContext runs at whatever rate the
 * OS hands us (usually 44100/48000), so everything captured off the
 * AudioWorklet has to be linearly resampled down to 24k before it's encoded
 * and shipped over the WebSocket.
 */

const XAI_SAMPLE_RATE = 24000;

/**
 * Linear-interpolation resample of a mono Float32 buffer from `fromRate` to
 * `toRate`. Good enough for speech-band mic audio going into a network
 * codec — not broadcast quality, but cheap enough to run per-frame on an
 * 8GB laptop without a dedicated resampler worklet.
 */
export function resampleFloat32(
  input: Float32Array,
  fromRate: number,
  toRate: number = XAI_SAMPLE_RATE,
): Float32Array {
  if (fromRate === toRate || input.length === 0) {
    return input;
  }

  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const srcIndexLow = Math.floor(srcPos);
    const srcIndexHigh = Math.min(srcIndexLow + 1, input.length - 1);
    const frac = srcPos - srcIndexLow;
    const lo = input[srcIndexLow] ?? 0;
    const hi = input[srcIndexHigh] ?? lo;
    out[i] = lo + (hi - lo) * frac;
  }

  return out;
}

/** Float32 [-1, 1] samples -> signed 16-bit little-endian PCM bytes. */
export function float32ToPCM16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return out;
}

/** Signed 16-bit little-endian PCM -> Float32 [-1, 1] samples. */
export function pcm16ToFloat32(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const v = input[i] ?? 0;
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return out;
}

/** Int16Array -> base64 string, safe for `input_audio_buffer.append`. */
export function int16ToBase64(input: Int16Array): string {
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/** base64 PCM16 (as sent by xAI in audio deltas) -> Int16Array samples. */
export function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  // Ensure alignment: PCM16 is 2 bytes/sample. Truncate any stray odd byte
  // rather than throwing on a malformed/partial frame from the wire.
  const sampleCount = Math.floor(bytes.length / 2);
  return new Int16Array(bytes.buffer, bytes.byteOffset, sampleCount);
}

/**
 * One-shot helper for the mic path: resample a worklet-captured Float32
 * frame to 24kHz, convert to PCM16, and base64-encode it for
 * `input_audio_buffer.append`.
 */
export function encodeMicFrame(
  frame: Float32Array,
  contextSampleRate: number,
): string {
  const resampled = resampleFloat32(frame, contextSampleRate, XAI_SAMPLE_RATE);
  const pcm16 = float32ToPCM16(resampled);
  return int16ToBase64(pcm16);
}

/** One-shot helper for playback: base64 PCM16 @ 24kHz -> Float32 samples. */
export function decodePlaybackFrame(base64: string): Float32Array {
  return pcm16ToFloat32(base64ToInt16(base64));
}

/** Root-mean-square amplitude of a Float32 frame — used for the client-side barge-in gate. */
export function rms(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / frame.length);
}

/**
 * WHERE A PLAYBACK FRAME LANDS ON THE CLOCK — and whether the queue is the
 * problem or the victim.
 *
 * Her audio arrives as many small deltas per second and is scheduled
 * back-to-back on the AudioContext clock: each buffer starts at the tail of the
 * one before it (`nextStart`), never before `now`. Two very different faults
 * look identical from the outside ("the call is laggy"):
 *
 *   LAG      `leadMs` is large — frames are arriving faster than they play, so
 *            the queue has built a backlog and she is speaking behind herself.
 *   STARVING `nextStart` has already fallen behind `now` — the queue drained
 *            before the next frame arrived, so there was an audible GAP and
 *            this frame starts immediately. That is a dropout, not latency, and
 *            adding buffering makes it worse.
 *
 * Pure arithmetic so the distinction is testable without an AudioContext
 * (tests/call-latency-boundaries.test.ts). `nextStart <= 0` is the reset value
 * — no queue exists yet — and is never reported as a dropout.
 */
export interface PlaybackLead {
  /** AudioContext time this buffer should be started at. */
  startAt: number;
  /** How far in the future that is, in ms. 0 means "playing right now". */
  leadMs: number;
  /** The queue had already run dry when this frame arrived. */
  starving: boolean;
}

export function playbackLead(ctxTime: number, nextStart: number): PlaybackLead {
  const startAt = Math.max(ctxTime, nextStart);
  return {
    startAt,
    leadMs: (startAt - ctxTime) * 1000,
    starving: nextStart > 0 && nextStart <= ctxTime,
  };
}

export const REALTIME_SAMPLE_RATE = XAI_SAMPLE_RATE;
