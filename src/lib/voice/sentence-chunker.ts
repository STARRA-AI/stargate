/**
 * SENTENCE CHUNKER — pure text splitting for the voice queue.
 *
 * Purpose: let speak.ts start talking on the first complete sentence of a
 * streamed reply instead of waiting for the whole thing, and queue the rest
 * as more sentences. No imports from speak.ts, no DOM, no fetch — this file
 * only slices strings so it can be unit-tested without any of that.
 *
 * DELIBERATELY DUMB, ON PURPOSE. This does not know "Mr." or "Dr." are
 * abbreviations. A terminator ([.!?]) followed by whitespace or end-of-string
 * ends a sentence, full stop (pun intended). An early split on an
 * abbreviation is harmless for a voice queue — it just means she takes a
 * beat mid-title. A maintained abbreviation dictionary is the opposite: a
 * heuristic that grows forever and still misses cases. See CLAUDE.md's
 * no-spend-on-thrash doctrine — this is the same principle applied to code.
 * ponytail: no abbreviation list; upgrade only if a real transcript shows it
 * costing something worse than a beat of silence.
 */

// One or more [.!?] run together (so "..." splits as one ellipsis, not three
// empty sentences) followed by whitespace or the end of the string.
const TERMINATOR_RE = /[.!?]+(?=\s|$)/;

// A blank line — newline, optional horizontal whitespace, another newline —
// ends a sentence even with no punctuation at all.
const BLANK_LINE_RE = /\n[ \t]*\r?\n/;

export interface SentenceSplit {
  first: string;
  rest: string;
  /**
   * TRUE only when a real sentence break was FOUND — a terminator or a blank
   * line. Load-bearing for the streaming caller, not decoration.
   *
   * On a partial buffer mid-stream, `"Hey Classic, I pulled"` returns
   * `first: "Hey Classic, I pulled", rest: ""` — byte-identical in shape to a
   * finished single sentence at end-of-stream. Without this flag the caller
   * cannot tell "a whole sentence is ready, speak it" from "the model is still
   * typing, wait" — and speaking the second one cuts her off mid-word, which is
   * the exact failure chunked speech exists to avoid. So: while the stream is
   * open, speak only when `complete`; when the stream closes, flush whatever
   * is left regardless.
   */
  complete: boolean;
}

export function splitFirstSentence(text: string): SentenceSplit {
  if (text.length === 0) {
    return { first: "", rest: "", complete: false };
  }

  const terminatorMatch = TERMINATOR_RE.exec(text);
  const blankLineMatch = BLANK_LINE_RE.exec(text);

  if (terminatorMatch && (!blankLineMatch || terminatorMatch.index <= blankLineMatch.index)) {
    const splitEnd = terminatorMatch.index + terminatorMatch[0].length;
    return {
      first: text.slice(0, splitEnd).trim(),
      rest: text.slice(splitEnd).trim(),
      complete: true,
    };
  }

  if (blankLineMatch) {
    return {
      first: text.slice(0, blankLineMatch.index).trim(),
      rest: text.slice(blankLineMatch.index + blankLineMatch[0].length).trim(),
      complete: true,
    };
  }

  // No terminator, no blank line: the whole text is one sentence — or an
  // unfinished one still streaming in. `complete: false` is how the caller
  // tells those apart.
  return { first: text.trim(), rest: "", complete: false };
}

export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const { first, rest } = splitFirstSentence(remaining);
    if (first.length > 0) {
      sentences.push(first);
    }
    // A leading blank-line match can yield an empty `first` with a
    // strictly-shorter `rest` (trim() always consumes the break) — keep
    // advancing either way so a run of blank lines can never loop forever.
    if (rest.length === 0) {
      break;
    }
    remaining = rest;
  }

  return sentences;
}

/**
 * How many pieces a single reply may be broken into for the voice queue.
 *
 * WHY THERE IS A CEILING AT ALL. speakStarraChunks fires EVERY chunk's
 * synthesis at once — that parallelism is the whole point (chunk 2 is already
 * downloading while chunk 1 is speaking, so the queue is never slower than
 * speaking the reply whole). But it means chunk count == simultaneous POSTs to
 * /api/tts. A twelve-sentence reply split per sentence would open twelve xAI
 * requests in the same instant, and the failure that buys is a rate-limited
 * chunk 6 — i.e. her reply stopping DEAD halfway through, which is the exact
 * shape voice-fallback-policy.ts refuses to paper over with a second voice.
 *
 * Three is the smallest number that still buys the thing worth having: the
 * FIRST sentence synthesizes alone, so time-to-first-sound is the length of
 * one sentence instead of the length of the whole reply.
 */
export const MAX_SPEECH_CHUNKS = 3;

/**
 * Below this many characters a reply is not worth splitting: the first
 * sentence's synthesis and the whole reply's synthesis take nearly the same
 * time, so chunking would add a seam between sentences and buy nothing.
 */
export const MIN_CHUNKABLE_CHARS = 180;

/**
 * Break a finished reply into speech chunks, first sentence first.
 *
 * The first chunk is ALWAYS exactly one sentence — that is what makes her
 * start talking sooner. The remainder is packed into at most
 * `MAX_SPEECH_CHUNKS - 1` further chunks of roughly equal length, split only
 * on real sentence boundaries so a chunk never ends mid-clause.
 *
 * Returns a single-element array whenever splitting would not help (short
 * reply, one sentence, empty). The caller can then take the plain
 * speakStarra path unchanged.
 */
export function chunkForSpeech(
  text: string,
  maxChunks: number = MAX_SPEECH_CHUNKS,
): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length < MIN_CHUNKABLE_CHARS) return [trimmed];

  const cap = Math.max(1, Math.floor(maxChunks));
  if (cap === 1) return [trimmed];

  const sentences = splitSentences(trimmed);
  if (sentences.length <= 1) return [trimmed];

  const [first, ...rest] = sentences;
  if (rest.length === 0) return [first];

  // Pack the tail into (cap - 1) buckets by length, never mid-sentence. The
  // target is the mean bucket size; a sentence that would push a bucket past
  // it starts the next one, as long as buckets remain.
  const tailChars = rest.reduce((n, s) => n + s.length + 1, 0);
  const buckets = Math.min(cap - 1, rest.length);
  const target = tailChars / buckets;

  const out: string[] = [first];
  let current = "";
  for (const sentence of rest) {
    const remainingBuckets = buckets - (out.length - 1);
    if (current.length === 0) {
      current = sentence;
      continue;
    }
    // Only close a bucket while there is another one left to open, or the
    // tail would lose its last sentences entirely.
    if (remainingBuckets > 1 && current.length >= target) {
      out.push(current);
      current = sentence;
      continue;
    }
    current = `${current} ${sentence}`;
  }
  if (current.length > 0) out.push(current);

  return out;
}
