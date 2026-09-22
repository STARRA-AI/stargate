/**
 * text-visemes — drive her mouth from the WORDS she is about to say.
 *
 * WHAT THIS IS. She knows the text before the speakers make a sound
 * (speakForced, speakStarra, speakLocalStream). Until now the viseme pick
 * was loudness + an F2 proxy (viseme-sync.ts), so every loud frame looked
 * like the same open mouth. This module turns that text into a timeline of
 * shapes: which viseme, and when. The existing analyser envelope still
 * says HOW FAR open, and pickVisemeFrame4 is still the only renderer.
 *
 * WHAT THIS IS NOT. Not a phonemizer, not CMUdict, not neural. A grapheme
 * walk with English digraphs. Good enough for bilabial closures (m/b/p)
 * to actually shut and for oo/ee/ah to land on different roundness. The
 * bank is still 16 frames at half-open — this cannot invent a wider jaw.
 *
 * CLOCK. Cues are 0..1 through the utterance. `arm` builds them;
 * `begin` stamps the moment sound actually starts (the same instant the
 * bus publishes speaking); `sample` reads elapsed / durationMs. Starting
 * the clock at arm would put her mouth AHEAD of eve, which is the lead
 * viseme-sync already compensates with the DAC delay ring.
 *
 * TOTAL, PURE, DOM-free except the module-level armed track (mirrors
 * ttsSnapshot in speak.ts). No regex lookbehind — macOS 12 WebKit.
 */

export interface TextVisemeCue {
  /** Start of this shape, 0..1 through the utterance. */
  t: number;
  /**
   * Nominal aperture of this shape 0..1. The envelope multiplies this;
   * it is NOT loudness.
   */
  openness: number;
  /** 0 = spread (ee), 1 = round (oo). */
  roundness: number;
  /** Force the dedicated closed frame — /m/ /b/ /p/. */
  closed: boolean;
}

export interface TextVisemeUnit {
  closed: boolean;
  openness: number;
  roundness: number;
  /** Relative duration. Vowels > consonants; a space is a short rest. */
  weight: number;
}

/** Slow-conversational: ~150 wpm ≈ 12.5 chars/s, viseme units are coarser. */
export const TEXT_VISEME_MS_PER_WEIGHT = 85;

/** A one-word reply still needs a timeline or the sample is a single spike. */
export const TEXT_VISEME_MIN_MS = 280;

const REST: TextVisemeUnit = {
  closed: false,
  openness: 0,
  roundness: 0.5,
  weight: 0.55,
};

const CLOSED: TextVisemeUnit = {
  closed: true,
  openness: 0,
  roundness: 0.5,
  weight: 1.2,
};

/**
 * Longest-first digraphs / trigraphs. Tried before the single letter so
 * "th" is never t+h and "oo" is never two open o's.
 */
const MULTI: Record<string, TextVisemeUnit> = {
  igh: { closed: false, openness: 0.4, roundness: 0.14, weight: 2.2 },
  ch: { closed: false, openness: 0.3, roundness: 0.45, weight: 1 },
  sh: { closed: false, openness: 0.3, roundness: 0.45, weight: 1 },
  th: { closed: false, openness: 0.18, roundness: 0.16, weight: 1 },
  ng: { closed: false, openness: 0.32, roundness: 0.4, weight: 1 },
  wh: { closed: false, openness: 0.3, roundness: 0.88, weight: 1.1 },
  qu: { closed: false, openness: 0.3, roundness: 0.9, weight: 1.2 },
  oo: { closed: false, openness: 0.34, roundness: 0.96, weight: 2 },
  ee: { closed: false, openness: 0.34, roundness: 0.08, weight: 2 },
  ea: { closed: false, openness: 0.36, roundness: 0.12, weight: 2 },
  oa: { closed: false, openness: 0.5, roundness: 0.76, weight: 2 },
  ou: { closed: false, openness: 0.48, roundness: 0.7, weight: 2 },
  ow: { closed: false, openness: 0.48, roundness: 0.7, weight: 2 },
  ai: { closed: false, openness: 0.46, roundness: 0.2, weight: 2 },
  ay: { closed: false, openness: 0.46, roundness: 0.2, weight: 2 },
  oy: { closed: false, openness: 0.42, roundness: 0.66, weight: 2 },
  oi: { closed: false, openness: 0.42, roundness: 0.66, weight: 2 },
  aw: { closed: false, openness: 0.55, roundness: 0.72, weight: 2 },
  au: { closed: false, openness: 0.55, roundness: 0.72, weight: 2 },
  ew: { closed: false, openness: 0.34, roundness: 0.9, weight: 2 },
};

function unitForLetter(ch: string): TextVisemeUnit {
  switch (ch) {
    case "m":
    case "b":
    case "p":
      return CLOSED;
    case "w":
      return { closed: false, openness: 0.3, roundness: 0.95, weight: 1.15 };
    case "u":
      return { closed: false, openness: 0.34, roundness: 0.9, weight: 2 };
    case "o":
      return { closed: false, openness: 0.55, roundness: 0.78, weight: 2 };
    case "a":
      return { closed: false, openness: 0.9, roundness: 0.18, weight: 2 };
    case "e":
    case "i":
    case "y":
      return { closed: false, openness: 0.34, roundness: 0.1, weight: 2 };
    case "f":
    case "v":
      return { closed: false, openness: 0.12, roundness: 0.28, weight: 1 };
    case "r":
      return { closed: false, openness: 0.28, roundness: 0.72, weight: 1 };
    case "q":
      return { closed: false, openness: 0.3, roundness: 0.9, weight: 1 };
    case "s":
    case "z":
    case "t":
    case "d":
    case "n":
    case "l":
      return { closed: false, openness: 0.2, roundness: 0.18, weight: 1 };
    case "c":
    case "k":
    case "g":
    case "x":
    case "h":
    case "j":
      return { closed: false, openness: 0.28, roundness: 0.3, weight: 1 };
    default:
      return REST;
  }
}

function isLetter(ch: string): boolean {
  return ch >= "a" && ch <= "z";
}

/**
 * Lowercase, keep letters / spaces / apostrophes. Apostrophes stay so
 * "I'm" still yields the closing m. No lookbehind.
 */
export function visemeSourceText(text: string): string {
  if (!text) return "";
  let out = "";
  const s = text.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (isLetter(c) || c === "'" || c === " " || c === "\n" || c === "\t") {
      out += c === "\n" || c === "\t" ? " " : c;
    } else {
      out += " ";
    }
  }
  let collapsed = "";
  let space = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (c === " ") {
      if (!space && collapsed.length > 0) collapsed += " ";
      space = true;
    } else {
      collapsed += c;
      space = false;
    }
  }
  return collapsed.trim();
}

/**
 * Grapheme walk → viseme units, in order. Empty / non-speech input
 * returns [] — the caller then leaves the mouth on the audio envelope.
 */
export function unitsFromText(text: string): TextVisemeUnit[] {
  const src = visemeSourceText(text);
  if (!src) return [];
  const units: TextVisemeUnit[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " ") {
      units.push(REST);
      i += 1;
      continue;
    }
    if (c === "'") {
      i += 1;
      continue;
    }
    const tri = src.slice(i, i + 3);
    if (MULTI[tri]) {
      units.push(MULTI[tri]);
      i += 3;
      continue;
    }
    const di = src.slice(i, i + 2);
    if (MULTI[di]) {
      units.push(MULTI[di]);
      i += 2;
      continue;
    }
    units.push(unitForLetter(c));
    i += 1;
  }
  return units;
}

export function estimateSpeechMs(text: string): number {
  const units = unitsFromText(text);
  let w = 0;
  for (let i = 0; i < units.length; i++) w += units[i].weight;
  const ms = w * TEXT_VISEME_MS_PER_WEIGHT;
  if (!Number.isFinite(ms) || ms <= 0) return TEXT_VISEME_MIN_MS;
  return ms < TEXT_VISEME_MIN_MS ? TEXT_VISEME_MIN_MS : ms;
}

/**
 * Place units on a 0..1 timeline. A leading rest at t=0 so sample(0)
 * is never a random mid-word shape if begin() races the first tick.
 */
export function scheduleTextVisemes(text: string): TextVisemeCue[] {
  const units = unitsFromText(text);
  if (units.length === 0) return [];
  let total = 0;
  for (let i = 0; i < units.length; i++) total += units[i].weight;
  if (!(total > 0)) return [];
  const cues: TextVisemeCue[] = [{ t: 0, openness: 0, roundness: 0.5, closed: false }];
  let acc = 0;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const t = acc / total;
    const last = cues[cues.length - 1];
    // Collapse identical neighbours so the sample walk stays short.
    if (
      last &&
      last.closed === u.closed &&
      last.openness === u.openness &&
      last.roundness === u.roundness
    ) {
      acc += u.weight;
      continue;
    }
    cues.push({
      t,
      openness: u.openness,
      roundness: u.roundness,
      closed: u.closed,
    });
    acc += u.weight;
  }
  return cues;
}

/**
 * Cue at progress 0..1. Before the first cue / garbage progress → rest.
 * After the last cue → last cue (hold), not wrap — wrapping would put
 * an "m" on the tail of a vowel.
 */
export function sampleTextViseme(
  cues: readonly TextVisemeCue[] | null | undefined,
  progress: number,
): TextVisemeCue | null {
  if (!cues || cues.length === 0) return null;
  const p = Number.isFinite(progress) ? progress : 0;
  if (p <= 0) return cues[0];
  let best = cues[0];
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].t <= p) best = cues[i];
    else break;
  }
  return best;
}

// ── armed track (one utterance; publishers arm/begin/clear) ────────────

interface ArmedTrack {
  cues: TextVisemeCue[];
  startedAt: number;
  durationMs: number;
  started: boolean;
}

let armed: ArmedTrack | null = null;

function nowMs(): number {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch {
    /* fall through */
  }
  return Date.now();
}

/**
 * Build the timeline from the text she is about to say. Does NOT start
 * the clock — beginTextVisemes does, when sound actually starts.
 */
export function armTextVisemes(text: string, durationMs?: number): void {
  const cues = scheduleTextVisemes(text);
  if (cues.length === 0) {
    armed = null;
    return;
  }
  const dur =
    Number.isFinite(durationMs) && (durationMs as number) > 0
      ? (durationMs as number)
      : estimateSpeechMs(text);
  armed = {
    cues,
    startedAt: 0,
    durationMs: dur < TEXT_VISEME_MIN_MS ? TEXT_VISEME_MIN_MS : dur,
    started: false,
  };
}

/** Stamp the moment sound starts. No-op if nothing is armed. */
export function beginTextVisemes(atMs?: number): void {
  if (!armed) return;
  const t = Number.isFinite(atMs as number) ? (atMs as number) : nowMs();
  armed.startedAt = t;
  armed.started = true;
}

/**
 * Replace the estimated duration with a measured one (audio.duration).
 * Progress is elapsed/duration, so a more honest duration keeps the
 * shapes locked to the real recording.
 */
export function setTextVisemeDuration(durationMs: number): void {
  if (!armed) return;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  armed.durationMs = durationMs < TEXT_VISEME_MIN_MS ? TEXT_VISEME_MIN_MS : durationMs;
}

export function clearTextVisemes(): void {
  armed = null;
}

export function isTextVisemeArmed(): boolean {
  return armed !== null;
}

/**
 * Cue for the mouth tick. `atMs` should already be delay-compensated
 * (the same `now - outputDelay` the openness ring uses) so the shape
 * and the jaw land on the sound leaving the speakers, not the analyser.
 *
 * Null when nothing is armed OR the clock has not begun — the tick then
 * keeps today's audio-only pick. Never throws.
 */
export function sampleArmedTextViseme(atMs: number): TextVisemeCue | null {
  try {
    if (!armed || !armed.started || armed.cues.length === 0) return null;
    const t = Number.isFinite(atMs) ? atMs : nowMs();
    const elapsed = t - armed.startedAt;
    if (!(elapsed >= 0) || !(armed.durationMs > 0)) return armed.cues[0];
    const progress = elapsed / armed.durationMs;
    return sampleTextViseme(armed.cues, progress > 1 ? 1 : progress);
  } catch {
    return null;
  }
}

/** Test / hot-reload: drop the armed track. */
export function resetTextVisemes(): void {
  armed = null;
}

// ── SHAPING: text says WHICH shape, the analyser still says HOW LOUD ────────

/**
 * The aperture a "normal" spoken vowel carries in the table above (oo/ee/ew
 * are 0.34, oa/aw are 0.5). Dividing a cue's nominal openness by this turns
 * it into a RELATIVE factor around 1.0, which is what lets the analyser
 * envelope keep owning the overall level.
 *
 * WHY A RATIO AND NOT THE RAW VALUE. `cue.openness` is a nominal aperture,
 * not a loudness — multiplying the envelope by it directly would scale every
 * frame DOWN (0.34 x 0.5 = 0.17) and she would mumble through the whole reply
 * with a barely-parted mouth. The ratio leaves an average vowel at the
 * envelope's own value and moves only the shapes that genuinely differ.
 */
export const TEXT_VISEME_REF_OPENNESS = 0.4;

/**
 * Ceiling on that factor. `a` is 0.9 nominal, i.e. 2.25x the reference, so an
 * unbounded factor would push every open vowel onto the same top frame and
 * flatten the very distinction this module exists to draw.
 *
 * ★ THE SECOND HALF OF THIS COMMENT USED TO READ "and the bank tops out at 0.55
 * anyway". IT NO LONGER DOES — the 2026-09-22 --full-range rebuild took the bank
 * to openness 1.0 and viseme-sync's opennessCeiling with it. The 1.8 value is
 * KEPT unchanged on purpose: at a typical envelope it now asks for ~0.72, which
 * lands on a genuinely open real frame instead of the old clamped half-open one,
 * and moving the bank and the gain in the same change would make it impossible
 * to attribute what altered her mouth. Raise it only with the contact sheet
 * (scripts/viseme-contact-sheet.py) open.
 */
export const TEXT_VISEME_MAX_SHAPE_GAIN = 1.8;

export interface ShapedMouth {
  openness: number;
  roundness: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Combine the audio envelope with the text cue for this instant.
 *
 * - No cue (nothing armed, clock not begun, or the utterance is over):
 *   returns the audio values UNCHANGED. That is today's behaviour, and it is
 *   the fallback whenever text visemes are not driving — never a silent
 *   degrade to something different-looking.
 * - `closed` cue (/m/ /b/ /p/): openness 0, whatever the envelope says. A
 *   bilabial that stays open is the single most obvious lip-sync tell.
 * - Otherwise: roundness comes from the TEXT (spread for ee, round for oo),
 *   which the F2 proxy could only guess at, and openness stays the envelope's
 *   scaled by how open this shape is relative to an average vowel.
 *
 * Total and pure — no DOM, no throw, garbage in gives rest out.
 */
export function shapeMouth(
  envelope: number,
  audioRoundness: number,
  cue: TextVisemeCue | null | undefined,
): ShapedMouth {
  const env = clamp01(envelope);
  const audioRound = Number.isFinite(audioRoundness) ? clamp01(audioRoundness) : 0.5;
  if (!cue) return { openness: env, roundness: audioRound };
  if (cue.closed) return { openness: 0, roundness: clamp01(cue.roundness) };

  const nominal = Number.isFinite(cue.openness) ? cue.openness : 0;
  let gain = nominal / TEXT_VISEME_REF_OPENNESS;
  if (!Number.isFinite(gain) || gain < 0) gain = 0;
  if (gain > TEXT_VISEME_MAX_SHAPE_GAIN) gain = TEXT_VISEME_MAX_SHAPE_GAIN;

  return { openness: clamp01(env * gain), roundness: clamp01(cue.roundness) };
}
