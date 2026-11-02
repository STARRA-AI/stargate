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
 * to actually shut and for oo/ee/ah to land on different roundness. What it
 * cannot do is ask for a shape the bank does not hold: the shipped
 * public/avatar/visemes3/bank.json is a 5x5 grid — 24 entries over five
 * openness rungs (0/0.25/0.5/0.75/1.0) x five roundness columns
 * (0.05/0.275/0.5/0.725/0.95), read off its own `coverage.cells` 2026-09-30 —
 * so every request quantizes onto one of those cells.
 *
 * CORRECTED 2026-09-30. This used to read "the bank is still 16 frames at
 * half-open — this cannot invent a wider jaw". 16-at-half-open was the FIRST v4
 * bank. `jq '.opennessCeiling, (.frames|length), ([.frames[].openness]|max)'` on
 * the shipped bank returns 1.0 / 24 / 1.0, and this same file already carried the
 * correction at :879 while the header still asserted the old limit — a
 * false capability claim in the first thing a reader of this file sees.
 *
 * CLOCK. Cues are 0..1 through the utterance. `arm` builds them;
 * `begin` stamps the moment sound actually starts (the same instant the
 * bus publishes speaking). Starting the clock at arm would put her mouth
 * AHEAD of eve, which is the lead viseme-sync already compensates with the
 * DAC delay ring.
 *
 * ★ THE POSITION IS THE AUDIO, WHEN A LEG CAN SUPPLY ONE (2026-09-30). The
 * wall clock is only the fallback now. A leg that owns a real playback
 * position installs it with setTextVisemeClockSource and `sample` reads THAT
 * instead of performance.now(): the TTS leg hands over
 * HTMLMediaElement.currentTime (speak.ts), the call leg hands over how much of
 * the queue has actually been consumed (useVoiceCall.ts).
 *
 * BE PRECISE ABOUT WHAT THAT BUYS, because the loose version of this sentence
 * was wrong: a POSITION cannot drift from the audio it is a position IN. A clock
 * merely denominated in audio time can — AudioContext.currentTime keeps running
 * through a gap in the queue, so it is a wall clock wearing the audio's units.
 * That distinction is the whole reason the call leg's source is written as
 * "enqueued minus still-queued" rather than "now minus the first sample".
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

/**
 * MEASURED, not assumed: 203 wpm. The old 85 encoded ~125 wpm, which ran the
 * schedule 1.634x too slow — 388ms of drift per second she spoke.
 *
 * SCOPE, AND IT DIFFERS BY LEG. On the CALL leg this is only the SEED for the
 * per-call calibration in useVoiceCall.ts, which measures her real rate from
 * each completed turn, so it governs the FIRST turn of a call and how fast the
 * blend converges — not the steady state. The typed-chat TTS leg (speak.ts) has
 * NO calibration: there this value IS the estimate, corrected only when the
 * blob's real length lands (setTextVisemeDuration). So the 85 -> 52 change moved
 * that leg's operating rate, and nothing in this repo has measured eve against
 * it — the 203 wpm figure was taken on the call lane.
 */
export const TEXT_VISEME_MS_PER_WEIGHT = 52;

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

// ── COARTICULATION ────────────────────────────────────────────────────────
/**
 * Every unit above describes a shape in ISOLATION, as if the mouth teleported
 * to it and held it. Real mouths do not: a short sound never reaches the
 * aperture a long one does, and every shape is pulled toward the one before it
 * and the one after. Shapes computed independently are exactly what reads as
 * stamped-on and robotic no matter how good the frames are.
 *
 * Two ideas are taken from the documented algorithm in Rhubarb Lip Sync (MIT) —
 * reimplemented here as arithmetic over this module's own axes. Nothing is
 * downloaded and no dependency is added:
 *
 *  1. DURATION-DEPENDENT SHAPES. Rhubarb varies the set of shapes a phone may
 *     use with that phone's duration. Here the duration sets how far along the
 *     path to its target a unit is allowed to travel (`coarticulationReach`).
 *  2. UNDERSHOOT TOWARD THE TARGET, not a commitment to it. The unit lands
 *     part-way from where the mouth is to where the sound wants it, with
 *     ROUNDNESS travelling 1.35x further than openness (lips round across a
 *     whole syllable while the jaw moves per phone — the same fact viseme-sync
 *     encodes as ROUNDNESS_TAU_MS 120 against ATTACK_MS 35). That asymmetry is
 *     why the landing point sits OFF the straight line to the target.
 *
 * WHAT THIS IS NOT, so the next reader does not look for it: there is no real
 * search. `admissibleShapes` returns at most two members, the reduced one is by
 * construction never further from the current position than the full target, so
 * `nearestAdmissible` over that set always resolves to `reach >= 1 ? full :
 * reduced`. The Rhubarb "nearest admissible" framing was dropped for that
 * reason — the duration-dependent reach above is the part that is really
 * borrowed, and it is the part that does the work. `nearestAdmissible` is kept
 * as a general 2D helper (and tested as one) so a WIDER admissible set can be
 * introduced later without rewriting the walk.
 *
 * MEASURED, AND THE MEASUREMENT IS PINNED BY A TEST rather than by this comment
 * — see "the level claims in the COART docstring are the measured ones" in
 * tests/mouth-clock-coarticulation.test.ts, which recomputes every number below
 * and fails if the constants drift. (An earlier revision of this docstring
 * carried 48 units / 27 at floor / +11.5%; those were wrong, which is exactly
 * why the numbers now live in an assertion.)
 *
 * Sentence: "I am right here with you and I am listening carefully".
 * At her calibrated 52ms/weight: 3237ms total, 49 units, 16 pinned at the
 * COART_MIN_REACH floor and ZERO at full reach — so on a normal sentence the
 * `full` branch is never taken and every shape undershoots.
 *
 * ★ RE-MEASURED 2026-10-04, and the reason the counts moved is the point: cues
 * are now CENTRED on their unit instead of pinned to its onset (see
 * scheduleTextVisemes), so the interval between consecutive cues is
 * (w_i + w_i+1)/2 — centre to centre — rather than w_i. That is the interval
 * the mouth actually has to travel between two target shapes, and it is longer
 * than the onset spacing on every short unit, so FEWER units are pinned at the
 * floor: 28 -> 16 here, and at 85ms/weight 18 -> 24 reach FULL. The shapes
 * themselves are untouched (mean 0.3038 and peak 0.8312 are identical before
 * and after), which is how you can tell this moved the TIMING and nothing else.
 *
 * AGAINST HEAD'S SCHEDULE, AND BOTH DIRECTIONS STATED: mean non-closed openness
 * 0.2745 -> 0.3038 (+10.7%) and the open-vowel peak 0.9000 -> 0.8312 (-7.6%).
 * Her mouth is on average MORE open and its loudest vowel LESS open. That is a
 * REDISTRIBUTION, not "essentially unchanged", and the flattened peak is the
 * cost side of it: if a wide-open 'a' matters more than the averaged fluidity,
 * raise COART_MIN_REACH or lower COART_SHORT_MS. That is a judgment call for the
 * face, not a defect here.
 *
 * At the old 85ms/weight the same sentence puts 24 of 49 units at FULL reach and
 * the peak is untouched (0.9000, 0.0%) — i.e. how much this changes depends on
 * her speaking rate, and the faster rate is where it bites.
 */
export const COART_SHORT_MS = 55;
export const COART_LONG_MS = 115;
/** Floor on the travel a very short unit gets. 0 would freeze her mouth. */
export const COART_MIN_REACH = 0.45;
/** Roundness travels this much faster than openness (capped at full). */
export const COART_ROUND_REACH = 1.35;
/** How much of the NEXT unit's shape is anticipated in this one. */
export const COART_ANTICIPATION = 0.16;

export interface MouthAxes {
  openness: number;
  roundness: number;
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/** 0.45 for a very short unit, 1 for a long one. Never outside that. */
export function coarticulationReach(unitMs: number): number {
  if (!Number.isFinite(unitMs) || unitMs <= 0) return COART_MIN_REACH;
  const span = COART_LONG_MS - COART_SHORT_MS;
  const d = span > 0 ? (unitMs - COART_SHORT_MS) / span : 1;
  const dc = d < 0 ? 0 : d > 1 ? 1 : d;
  return COART_MIN_REACH + (1 - COART_MIN_REACH) * dc;
}

/**
 * The shapes a unit of this duration is allowed to land on, starting from where
 * the mouth is. A long unit may reach its full target; a short one may only get
 * part of the way, with the lips travelling further than the jaw.
 *
 * At most two members, and they are ORDERED BY COMMITMENT: [full, reduced].
 * The reduced member lies on the path from `from` toward `full`, so it is never
 * further from `from` than `full` is — which is what makes the pick downstream
 * deterministic rather than a search. Widening this set is the one change that
 * would make nearestAdmissible's 2D distance load-bearing.
 */
export function admissibleShapes(
  from: MouthAxes,
  target: MouthAxes,
  unitMs: number,
): MouthAxes[] {
  const full = { openness: clamp01(target.openness), roundness: clamp01(target.roundness) };
  const reach = coarticulationReach(unitMs);
  if (reach >= 1) return [full];
  const rr = reach * COART_ROUND_REACH;
  return [
    full,
    {
      openness: clamp01(lerp(clamp01(from.openness), full.openness, reach)),
      roundness: clamp01(lerp(clamp01(from.roundness), full.roundness, rr > 1 ? 1 : rr)),
    },
  ];
}

/**
 * The member of `set` closest to `current` in (openness, roundness).
 *
 * A general helper, NOT the mechanism behind the coarticulation walk: fed the
 * two-member set admissibleShapes builds, it always returns the reduced member
 * when reach < 1 and the target when reach >= 1 (see the note above
 * COART_SHORT_MS). It earns its keep as a real 2D pick only over a wider set.
 */
export function nearestAdmissible(
  current: MouthAxes,
  set: readonly MouthAxes[],
): MouthAxes {
  if (!set || set.length === 0) return { openness: clamp01(current.openness), roundness: clamp01(current.roundness) };
  let best = set[0];
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < set.length; i++) {
    const dO = set[i].openness - current.openness;
    const dR = set[i].roundness - current.roundness;
    const d = dO * dO + dR * dR;
    if (d < bestD) {
      bestD = d;
      best = set[i];
    }
  }
  return best;
}

/**
 * Place units on a 0..1 timeline. A leading rest at t=0 so sample(0)
 * is never a random mid-word shape if begin() races the first tick.
 *
 * `msPerWeight` is how long one weight unit will actually be on screen, which
 * is what decides how far each unit is allowed to travel (see above). Left out,
 * the nominal rate is used and the schedule is the isolated-shape one.
 */
export function scheduleTextVisemes(text: string, msPerWeight?: number): TextVisemeCue[] {
  const units = unitsFromText(text);
  if (units.length === 0) return [];
  let total = 0;
  for (let i = 0; i < units.length; i++) total += units[i].weight;
  if (!(total > 0)) return [];
  const mpw =
    Number.isFinite(msPerWeight) && (msPerWeight as number) > 0
      ? (msPerWeight as number)
      : TEXT_VISEME_MS_PER_WEIGHT;
  const cues: TextVisemeCue[] = [{ t: 0, openness: 0, roundness: 0.5, closed: false }];
  let acc = 0;
  // Where the mouth is as the walk proceeds — the leading rest, to start.
  let pos: MouthAxes = { openness: 0, roundness: 0.5 };
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    // CENTRED ON ITS UNIT, NOT PINNED TO THE ONSET (2026-10-04).
    // `acc / total` is the instant the phone BEGINS. The step sampler this was
    // written for held each shape for the unit's whole duration, so an onset
    // timestamp read as "this shape covers this phone". The interpolating
    // sampler does not hold — it starts leaving the shape the moment it is
    // reached, so an onset cue makes every shape PEAK at the phone's start and
    // be half-travelled by its middle: a systematic half-unit lead across the
    // entire reply, worst on long vowels. Centring restores the invariant the
    // cue list is supposed to carry — the shape is fully reached where the
    // phone is loudest.
    const t = (acc + u.weight / 2) / total;
    acc += u.weight;
    let shape: MouthAxes;
    if (u.closed) {
      // A CLOSURE IS NOT NEGOTIABLE — no reach reduction, no anticipation. An
      // /m/ that stays open is the single most obvious lip-sync tell, and it is
      // the reason the shape axes are overridden rather than travelled toward.
      // The lips KEEP the rounding they had (pursed through an /m/ between two
      // /u/s) instead of snapping to neutral.
      shape = { openness: 0, roundness: clamp01(pos.roundness) };
    } else {
      // ANTICIPATION: a little of what comes next, so the shape leans into it.
      // A COMING CLOSURE IS NOT ANTICIPATED: its target aperture is 0, so
      // leaning toward it would eat the aperture off the vowel before every
      // /m/ /b/ /p/. The closure gets its own full shut on its own cue.
      const next = i + 1 < units.length ? units[i + 1] : null;
      const target: MouthAxes =
        next && !next.closed
          ? {
              openness: lerp(u.openness, next.openness, COART_ANTICIPATION),
              roundness: lerp(u.roundness, next.roundness, COART_ANTICIPATION),
            }
          : { openness: u.openness, roundness: u.roundness };
      shape = nearestAdmissible(pos, admissibleShapes(pos, target, u.weight * mpw));
    }
    pos = shape;
    const last = cues[cues.length - 1];
    // Collapse identical neighbours so the sample walk stays short.
    if (
      last &&
      last.closed === u.closed &&
      last.openness === shape.openness &&
      last.roundness === shape.roundness
    ) {
      continue;
    }
    cues.push({
      t,
      openness: shape.openness,
      roundness: shape.roundness,
      closed: u.closed,
    });
  }
  return cues;
}

/**
 * Cue at progress 0..1. Before the first cue / garbage progress → rest.
 * After the last cue → last cue (hold), not wrap — wrapping would put
 * an "m" on the tail of a vowel.
 *
 * ★ INTERPOLATED, not stepped (2026-09-30). This used to return the last cue
 * whose t had passed, so openness and roundness were STEP functions: her lip
 * width snapped between pursed and spread with nothing in between, and the
 * roundness smoother that was supposed to soften it never saw these values at
 * all. Her bank is continuous in both axes, so the honest answer is the point
 * BETWEEN the bracketing cues, and a continuous trajectory through a continuous
 * bank is what makes a mouth read fluid.
 *
 * THE CEILING ON THIS, STATED HERE SO NOBODY OVER-CLAIMS IT AGAIN: the VALUE is
 * continuous, the FRAMES are not. viseme-sync.ts:1897-1898 measures one roundness
 * COLUMN step on the shipped visemes3 bank at ~0.21, so an ee->oo transition
 * shows one or two intermediate frames instead of a hard jump. That is the win.
 * It is not a glide, and it cannot be one until the bank has more columns.
 *
 * `closed` stays a HARD boolean — taken from whichever bracketing cue is
 * nearer, never blended — because a bilabial must fully shut. Nearer (rather
 * than the one that has passed) also centres each shape on its cue instead of
 * lagging half a span behind it, and it lets the closure start slightly early,
 * which is how lips actually meet.
 */
export function sampleTextViseme(
  cues: readonly TextVisemeCue[] | null | undefined,
  progress: number,
): TextVisemeCue | null {
  if (!cues || cues.length === 0) return null;
  const p = Number.isFinite(progress) ? progress : 0;
  if (p <= 0) return cues[0];
  let at = 0;
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].t <= p) at = i;
    else break;
  }
  const from = cues[at];
  const to = at + 1 < cues.length ? cues[at + 1] : null;
  // Past the last cue: hold it, exactly as before.
  if (!to) return from;
  const span = to.t - from.t;
  if (!(span > 0)) return from;
  let f = (p - from.t) / span;
  if (!(f > 0)) return from;
  if (f > 1) f = 1;
  return {
    t: from.t,
    openness: from.openness + (to.openness - from.openness) * f,
    roundness: from.roundness + (to.roundness - from.roundness) * f,
    closed: f <= 0.5 ? from.closed : to.closed,
  };
}

// ── armed track (one utterance; publishers arm/begin/clear) ────────────

/**
 * A playback position in ms since the utterance's first sample, read fresh on
 * every mouth tick. A closure and not a number so the reading is never stale
 * between audio packets: a scalar fed per packet would hold her mouth still
 * for the gap and then jump.
 */
export type TextVisemeClock = () => number;

interface ArmedTrack {
  cues: TextVisemeCue[];
  startedAt: number;
  durationMs: number;
  started: boolean;
  /** Live audio clock, when the publishing leg has one. Beats the wall clock. */
  clock: TextVisemeClock | null;
  /** Last scalar position fed in, used only when there is no clock source. */
  positionMs: number | null;
  /**
   * Added to the raw position so that CHANGING durationMs does not move her
   * mouth. Both rescale paths re-pivot it — extendTextVisemeDuration (the
   * streaming lower bound, grows only) and setTextVisemeDuration (the measured
   * correction, either direction). See repivotForDuration.
   */
  offsetMs: number;
  /** The raw position the last sample read — the pivot the offset is computed at. */
  lastRawMs: number;
  /** Highest progress already shown. A belt against any backward step. */
  lastProgress: number;
}

let armed: ArmedTrack | null = null;

/**
 * Re-anchor `offsetMs` so the progress showing RIGHT NOW survives a change of
 * denominator EXACTLY. Progress is (rawMs + offsetMs) / durationMs, so moving
 * durationMs on its own moves her mouth: a bigger duration walks her BACK to a
 * shape she already made, a smaller one jumps her forward. Solving for the
 * offset that holds the displayed value fixed is what makes a rescale invisible.
 *
 * ONE RULE FOR BOTH CALLERS, deliberately: the streaming lower bound
 * (extendTextVisemeDuration) and the measured correction (setTextVisemeDuration)
 * used to disagree — the second zeroed the offset and the ratchet, which is a
 * visible step whenever it lands mid-playback, and speak.ts wires it to
 * `durationchange`, which can.
 *
 * The displayed value is clamped to 1 before it is preserved: a schedule already
 * run to its end re-pivots AT its end, never past it, or the overshoot would be
 * banked into the offset where the ratchet could never work it off.
 *
 * Call BEFORE assigning the new durationMs — it reads the old one.
 */
function repivotForDuration(track: ArmedTrack, next: number): void {
  const prev = track.durationMs;
  if (!track.started || !(prev > 0) || !(next > 0)) return;
  const at = track.lastRawMs + track.offsetMs;
  if (!(at > 0)) return;
  const raw = at / prev;
  const p = raw > 1 ? 1 : raw;
  track.offsetMs = p * next - track.lastRawMs;
}

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
 *
 * `keepClock` is for a turn that is spoken in SENTENCES: the second sentence
 * re-arms with sentence-1-plus-2 while her voice is already running, and a
 * fresh track (started: false) would drop her mouth to audio-only for the rest
 * of the turn. It carries the running anchor and audio clock over. The progress
 * RATCHET is deliberately NOT carried: the cue timeline was just rescaled, so
 * the old 0..1 number means a different word. The word POSITION is what stays
 * continuous (half of one sentence is a quarter of two), which is the invariant
 * that matters and the reason this is not a rewind.
 */
export function armTextVisemes(
  text: string,
  durationMs?: number,
  opts?: { keepClock?: boolean },
): void {
  const weight = textVisemeWeight(text);
  const raw =
    Number.isFinite(durationMs) && (durationMs as number) > 0
      ? (durationMs as number)
      : estimateSpeechMs(text);
  const dur = raw < TEXT_VISEME_MIN_MS ? TEXT_VISEME_MIN_MS : raw;
  // The ACTUAL ms each unit will occupy on screen — the timeline is stretched
  // over `dur`, floor included — so the coarticulation reach below is judged
  // against real dwell time rather than a nominal rate.
  //
  // IT REFLECTS THE ARMING ESTIMATE, NOT THE FINAL DURATION, and it is never
  // recomputed. extendTextVisemeDuration grows `durationMs` later in the turn
  // without re-running the walk, so the SHAPES stay sized for the rate known at
  // arm time while their TIMING follows the grown duration. Left that way on
  // purpose: re-scheduling mid-turn would replace her current shape wholesale,
  // which is exactly the pop this module exists to remove. Do not assume reach
  // tracks the duration — it tracks the estimate.
  const msPerWeight = weight > 0 ? dur / weight : TEXT_VISEME_MS_PER_WEIGHT;
  const cues = scheduleTextVisemes(text, msPerWeight);
  if (cues.length === 0) {
    armed = null;
    return;
  }
  const prev = armed;
  const keep = opts?.keepClock === true && prev !== null && prev.started;
  armed = {
    cues,
    startedAt: keep ? (prev as ArmedTrack).startedAt : 0,
    durationMs: dur,
    started: keep,
    clock: keep ? (prev as ArmedTrack).clock : null,
    positionMs: keep ? (prev as ArmedTrack).positionMs : null,
    offsetMs: 0,
    lastRawMs: keep ? (prev as ArmedTrack).lastRawMs : 0,
    lastProgress: 0,
  };
}

/**
 * Install the live audio clock for the CURRENT armed track (dropped with it, so
 * one leg's clock can never drive another leg's mouth). Pass null to fall back
 * to the wall clock.
 */
export function setTextVisemeClockSource(clock: TextVisemeClock | null): void {
  if (!armed) return;
  armed.clock = typeof clock === "function" ? clock : null;
}

/**
 * Feed a playback position in ms since the first sample of this utterance —
 * the scalar form of the clock above, for a leg that gets told the position
 * instead of being able to read it. Ignored while a clock source is installed.
 *
 * TEST-ONLY TODAY, and that is the right answer rather than an omission: BOTH
 * production legs can READ their position continuously, so both install a clock
 * source (above) instead of pushing a scalar —
 *   - the call leg off the AudioContext queue (useVoiceCall.ts, schedulePlayback)
 *   - the TTS leg off HTMLMediaElement.currentTime (speak.ts, both `playing`
 *     handlers)
 * A push at an event rate — `timeupdate` fires about 4x/second — would hold one
 * progress value for ~250ms and then jump, which is steppier than the wall clock
 * it replaced. Exercised by tests/mouth-clock-coarticulation.test.ts; kept for a
 * leg that genuinely cannot read (a worker, or a remote transport that only
 * reports).
 */
export function setTextVisemePosition(ms: number): void {
  if (!armed) return;
  if (!Number.isFinite(ms)) return;
  armed.positionMs = ms;
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
 *
 * ★ IT RE-PIVOTS INSTEAD OF RESETTING (2026-09-30). This used to zero `offsetMs`
 * and `lastProgress` on the theory that a measured correction should take effect
 * "immediately". It lands mid-playback: speak.ts wires it to the element's
 * `durationchange` (speak.ts:843 and :1360), which can fire after the clock is
 * running. Zeroing both made her mouth step to a different shape at that
 * instant, and at 52ms/weight that step is 1.63x the size it was at 85. It now
 * shares repivotForDuration with the streaming path, so the correction changes
 * the RATE from here on and never the shape showing now. The direction is
 * unrestricted — a measured duration may legitimately be shorter than the guess.
 */
export function setTextVisemeDuration(durationMs: number): void {
  if (!armed) return;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  const next = durationMs < TEXT_VISEME_MIN_MS ? TEXT_VISEME_MIN_MS : durationMs;
  repivotForDuration(armed, next);
  armed.durationMs = next;
}

/**
 * Stamp the moment sound starts — ONCE per armed track.
 *
 * WHY THE GUARD EXISTS. beginTextVisemes() re-stamps `startedAt`
 * unconditionally, so a caller that fires it more than once per utterance resets
 * the clock: elapsed goes back to ~0, progress never advances, and the renderer
 * is handed cues[0] — the rest shape — for the whole utterance. The realtime
 * call leg is exactly that kind of caller: its only per-audio hook lands many
 * times a second, and after this module's re-arm gate it can also land with a
 * track that is already running. Idempotent-per-arm is the property that call
 * site needs, so it is a property of the MODULE, not of the caller's bookkeeping.
 *
 * armTextVisemes() re-opens the gate (it builds a fresh track with
 * started: false) — unless `keepClock` carried a running one over, in which case
 * this is a no-op and the clock stays continuous, which is the point.
 */
export function beginTextVisemesOnce(atMs?: number): void {
  if (!armed || armed.started) return;
  beginTextVisemes(atMs);
}

/**
 * Grow the armed duration toward the real one, never shrink it.
 *
 * The realtime leg cannot know the turn's total length up front — audio
 * streams in. But audio RECEIVED so far is a hard lower bound on the total,
 * and it only ever grows. Feeding that bound in keeps her mouth from running
 * off the end of the schedule and freezing on the last shape.
 *
 * A MONOTONIC DURATION IS NOT ON ITS OWN A MONOTONIC PROGRESS — the opposite.
 * The duration is the DENOMINATOR, so raising it while the raw position is
 * unchanged LOWERS progress, and a bare extension would walk her mouth BACK to a
 * shape it had already made, several times a sentence. That is why every
 * extension re-pivots `offsetMs` (repivotForDuration): the progress showing at
 * this instant is preserved exactly, so her mouth neither steps back nor stalls
 * — it simply continues at the new, slower rate. (`lastProgress` in
 * sampleArmedTextViseme is the belt behind that braces.)
 */
export function extendTextVisemeDuration(durationMs: number): void {
  if (!armed) return;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return;
  const next = durationMs < TEXT_VISEME_MIN_MS ? TEXT_VISEME_MIN_MS : durationMs;
  if (!(next > armed.durationMs)) return;
  repivotForDuration(armed, next);
  armed.durationMs = next;
}

/**
 * Total relative weight of the text — the denominator for rate calibration.
 * estimateSpeechMs() is this times TEXT_VISEME_MS_PER_WEIGHT; exposing the
 * weight alone lets the call leg substitute a MEASURED ms-per-weight taken
 * from her actual voice instead of the 85ms guess.
 */
export function textVisemeWeight(text: string): number {
  const units = unitsFromText(text);
  let w = 0;
  for (let i = 0; i < units.length; i++) w += units[i].weight;
  return w;
}

export function clearTextVisemes(): void {
  armed = null;
}

export function isTextVisemeArmed(): boolean {
  return armed !== null;
}

/**
 * Is there a track that is armed AND running?
 *
 * THIS IS THE GATE A PUBLISHER MUST USE, not a boolean of its own. The armed
 * track is dropped per UTTERANCE (clearTextVisemes when her voice stops), while
 * a streaming caller thinks in TURNS — one turn is several utterances. A
 * per-turn flag says "already started" while the track it started no longer
 * exists, and then nothing re-arms the clock: her mouth has no shape track for
 * the rest of the reply. Asking the module removes the class of bug, because the
 * module owns the track's lifetime and the caller does not.
 */
export function isTextVisemeStarted(): boolean {
  return armed !== null && armed.started;
}

/**
 * The raw playback position for this track, in ms since its first sample.
 *
 * ORDER OF TRUTH: the installed audio clock, then the last scalar position fed
 * in, then — only if neither exists — the wall clock `atMs` against the
 * begin() anchor, which is exactly today's behaviour.
 */
function armedRawMs(track: ArmedTrack, atMs: number): number {
  if (track.clock) {
    try {
      const v = track.clock();
      if (Number.isFinite(v)) return v;
    } catch {
      /* a broken clock falls through to the wall clock, never throws */
    }
  }
  if (track.positionMs !== null && Number.isFinite(track.positionMs)) {
    return track.positionMs;
  }
  const t = Number.isFinite(atMs) ? atMs : nowMs();
  return t - track.startedAt;
}

/**
 * Cue for the mouth tick. `atMs` should already be delay-compensated
 * (the same `now - outputDelay` the openness ring uses) so the shape
 * and the jaw land on the sound leaving the speakers, not the analyser.
 * It is the FALLBACK clock: a fed audio position outranks it (armedRawMs),
 * and a leg feeding one is responsible for its own delay compensation.
 *
 * Null when nothing is armed OR the clock has not begun — the tick then
 * keeps today's audio-only pick. Never throws.
 */
export function sampleArmedTextViseme(atMs: number): TextVisemeCue | null {
  try {
    if (!armed || !armed.started || armed.cues.length === 0) return null;
    const raw = armedRawMs(armed, atMs);
    armed.lastRawMs = Number.isFinite(raw) && raw > 0 ? raw : 0;
    if (!(armed.durationMs > 0)) return armed.cues[0];
    let progress = (armed.lastRawMs + armed.offsetMs) / armed.durationMs;
    if (!(progress >= 0)) progress = 0;
    if (progress > 1) progress = 1;
    // HER MOUTH NEVER STEPS BACK. Both rescale paths re-pivot
    // (repivotForDuration), so this should already hold for them; the ratchet is
    // the belt that makes it a property of the MODULE rather than of any one
    // caller's arithmetic — it also covers a clock source that reports a
    // position going backwards, which this module cannot prevent at the source.
    if (progress < armed.lastProgress) progress = armed.lastProgress;
    else armed.lastProgress = progress;
    return sampleTextViseme(armed.cues, progress);
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
