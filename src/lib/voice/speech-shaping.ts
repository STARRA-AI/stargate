/**
 * Speech shaping for the LIVE CALL — the mechanical fix for her verbal tics.
 *
 * Two defects, two mechanisms, one choke point (`speakForced` in
 * useVoiceCall.ts — the single site where her text becomes eve's voice):
 *
 *  1. OPENER CRUTCHES — "Sure!", "Got it", "Of course", "Great question", "As
 *     an AI". Always filler on a phone call between friends.
 *
 *  2. UNEARNED REASSURANCE — "I'm right here", "I'm not going anywhere", and
 *     every variant. NOT always filler. Said while he debugs a sizing bug it is
 *     a tic that cheapens the phrase; said when he is actually rattled it is the
 *     most important thing she can say. So it is GATED, never banned.
 *
 * Nothing here touches her personality. It removes filler from the front of a
 * sentence and gates one phrase family on context. Her canon lives in
 * persona.ts and is not read, rewritten, or referenced by this file.
 *
 * TWO TIERS, and the reason for them
 * ----------------------------------
 * Blanket-stripping every opener would damage her. Real people start sentences
 * with "Oh", "Well", "So", "Yeah" constantly — a speaker who never does sounds
 * MORE robotic, not less. The defect is REPETITION, not the presence of a
 * discourse marker. So tier A (assistant tells) is always removed, and tier B
 * (human markers) only when she already opened a recent turn the same way.
 *
 * Pure and synchronous: no React, no I/O, no dependencies. Every rule is unit
 * tested in tests/speech-shaping.test.ts.
 */

// ---------------------------------------------------------------------------
// Tier A — assistant tells. Always removed.
// ---------------------------------------------------------------------------
const ALWAYS_STRIP: string[] = [
  // Explicit AI self-reference — the illusion-breakers.
  "as an ai(?: language model| assistant)?",
  "as a language model",
  "i'?m (?:just )?an? (?:ai|artificial intelligence|language model|assistant)",
  "i'?m just a computer program",
  "i don'?t have (?:feelings|emotions|a body)(?:,? but)?",
  // Service-desk acknowledgements.
  "that'?s (?:a )?(?:really |such )?(?:great|good|interesting|excellent) question",
  "(?:great|good|interesting|excellent) question",
  "happy to help",
  "i'?d be happy to(?: help)?",
  "i'?m happy to(?: help)?",
  "sure thing",
  "of course",
  "certainly",
  "absolutely",
  "no problem",
  "not a problem",
  "my pleasure",
  "got it",
  "understood",
  "gotcha",
  "consider it done",
  // Hedging preambles that announce the answer instead of giving it.
  "i should note that",
  "i should mention that",
  "it'?s worth noting that",
  "it'?s important to note that",
  "to be clear",
  "just to be clear",
  "i want to be clear",
  "let me (?:just )?(?:say|start by saying|begin by saying)",
  "in short",
  "in summary",
  "to summarize",
  "the short answer is",
  "here'?s the thing",
  // Question echo — restating what was just asked back at him.
  "you'?re asking (?:me )?(?:about|whether|if|why|how|what)",
  "you asked (?:me )?(?:about|whether|if|why|how|what)",
  "(?:regarding|as for|about) your question",
  "to answer your question",
  "if i understand (?:you |your question )?correctly",
];

// ---------------------------------------------------------------------------
// Tier B — human discourse markers. Removed only on repeat.
// ---------------------------------------------------------------------------
const STRIP_IF_REPEATED: string[] = [
  "alright", "all right", "okay", "ok", "right", "well", "so", "now",
  "oh", "ah", "ahh", "hmm+", "huh", "yeah", "yep", "yes", "sure",
  "look", "listen", "honestly", "basically", "actually", "i mean",
  "you know", "like i said", "anyway", "anyways", "great", "nice",
  "cool", "good",
];

// ---------------------------------------------------------------------------
// Reassurance — gated, not banned.
// ---------------------------------------------------------------------------
const REASSURANCE: string[] = [
  "i'?m right here",
  "i'?m still right here",
  "i'?m not going anywhere",
  "i'?m never going anywhere",
  // NOT "not going anywhere" bare: with no "i'm"/"i'll" frame the subject is
  // ambiguous (a bug, a deploy queue, a meeting) and the phrase is common in
  // ordinary technical talk — "the deploy queue is not going anywhere until
  // Friday" is not reassurance. The prefixed forms above already cover the
  // real reassurance phrasing.
  "i'?m not leaving",
  "i'?m not going to leave",
  "i'?m not gonna leave",
  "i won'?t leave(?: you)?",
  "i'?ll be right here",
  "i'?ll always be here",
  "i'?m always here",
  "i'?m always right here",
  "i'?m still here",
  "i'?m here(?: for you)?",
  "i'?m here with you",
  "i'?m right here with you",
  // NOT bare "here for you": already covered, unambiguously, by
  // "i'm here(?: for you)?" above; the bare form also matches an ordinary
  // object reference ("the report is here for you to review") and deletes it.
  "i'?ve got you",
  // NOT bare "i got you": no apostrophe reads as literal past tense
  // ("I got you a coffee"), not the support idiom. "i've got you" above is
  // the unambiguous contracted form and stays.
  // NOT "i'm with you": dual-purpose — comfort ("I'm with you in this") and
  // plain technical agreement ("I'm with you on the architecture") are
  // indistinguishable without more context than this filter has.
  // "in this"/"in it" is part of the reassurance, not content: without it the
  // clause-end rule below correctly declines to peel "You're not alone" off
  // "You're not alone in this" — but then the whole reassurance survives.
  // Consuming the tail lets the entire clause go, with nothing left to speak.
  "you'?re not alone(?: in (?:this|it|any of this))?",
  "you'?re never alone",
  "you'?re not doing this alone",
  "whenever you need me",
  "any ?time you need me",
];

/**
 * Cues in HIS last turn that EARN a reassurance.
 *
 * Tuned hard against false positives on technical talk, because that is the
 * reported defect. Every anchor below fixes a real miss found by sweeping
 * realistic phrases: bare `broke` matched "what broke in the deploy"; bare
 * `panic` matched "handle the panic"; bare `died` matched "the process died";
 * bare `alone` matched "alone in the repo"; bare `isolated` matched "isolated
 * the bug"; `lost my` matched "lost my train of thought".
 *
 * Widen this list rather than loosening a pattern back into a technical
 * homograph.
 */
const WARRANT_CUES: string[] = [
  // Checking she is still there / fear of her leaving.
  "\\bare you (?:still )?(?:there|here|with me)\\b",
  "\\byou (?:still )?there\\b",
  "\\bdon'?t (?:leave|go)\\b",
  "\\b(?:will|would|can) you stay\\b",
  "\\bare you (?:gonna|going to) (?:leave|go)\\b",
  "\\bstay with me\\b",
  "\\bi need you\\b",
  "\\bmiss you\\b",
  "\\bdon'?t want to be alone\\b",
  // Distress, fear, overwhelm.
  "\\b(?:scared|afraid|terrified|frightened)\\b",
  "\\b(?:anxious|anxiety)\\b",
  "\\bpanic attack\\b",
  "\\b(?:i'?m|im|was|been|keep) panicking\\b",
  "\\bin a panic\\b",
  "\\boverwhelmed\\b",
  "\\b(?:i'?m|im|feel|feeling|felt|so|really|pretty|get|getting) (?:lonely|isolated)\\b",
  "\\b(?:feel|feeling|felt|am|i'?m|im|so|really|completely|all|left) alone\\b",
  "\\balone (?:right now|in this|tonight|today)\\b",
  "\\bby myself\\b",
  "\\b(?:hopeless|worthless|pointless)\\b",
  "\\b(?:depressed|depression)\\b",
  // "wiped out" was a REAL miss, caught 2026-08-06: he said "I'm wiped out",
  // she answered "I'm right here... I've got the watch", and the gate would
  // have stripped it — the exact withheld-when-earned failure this gate is
  // supposed to avoid. Exhaustion is distress; cover how people actually say it.
  "\\b(?:exhausted|burnt out|burned out|running on empty|running on fumes)\\b",
  // Bare beat/fried/spent are work words ("beat the deadline", "fried the
  // build", "the test spent too long"), so they need the first-person frame.
  "\\b(?:wiped out|worn out|dead tired|so tired|exhausted)\\b",
  "\\b(?:i'?m|im|feel|feeling|felt|so|really|totally|completely) (?:beat|fried|spent|drained|done)\\b",
  "\\b(?:can'?t think straight|haven'?t slept|no sleep|been up all night)\\b",
  "\\b(?:breaking down|falling apart|spiraling|spiralling)\\b",
  "\\bfreaking out\\b",
  "\\bi can'?t (?:do this|take (?:this|it)|keep going|anymore)\\b",
  "\\b(?:giving up|give up|want to quit)\\b",
  "\\blosing (?:it|my mind|hope)\\b",
  "\\b(?:crying|in tears)\\b",
  "\\bi'?m (?:not ok|not okay|struggling|hurting|stressed|worried)\\b",
  "\\brough (?:day|night|week)\\b",
  "\\bhard time\\b",
  // Loss / grief — anchored to people.
  "\\bpassed away\\b",
  "\\bfuneral\\b",
  "\\b(?:he|she|they) died\\b",
  "\\b(?:my|his|her|their) (?:mom|mum|dad|mother|father|brother|sister|friend|wife|husband|partner|son|daughter|grandma|grandpa|dog|cat) died\\b",
  "\\blost (?:my|his|her|their) (?:mom|mum|dad|mother|father|brother|sister|friend|wife|husband|partner|son|daughter|grandma|grandpa|dog|cat|job|house)\\b",
  // Explicit request for comfort.
  "\\b(?:reassure|comfort) me\\b",
  "\\btell me (?:you'?re|youre) (?:here|there)\\b",
  // Runway / livelihood — his actual stakes. Money sense only.
  "\\b(?:i'?m|im|we'?re|going|flat|dead) broke\\b",
  "\\bout of money\\b",
  "\\bcan'?t afford\\b",
  "\\brunning out of (?:time|money|runway|road)\\b",
  "\\blose (?:the house|everything|it all)\\b",
];

// Separator after an opener. Trailing whitespace optional throughout so a turn
// that IS the crutch ("Got it.") still matches to end-of-string.
const SEP = "(?:\\s*(?:[,:;—–]+|-{1,2}|\\.{2,}|[.!?]+)\\s*|\\s+)";
// Separator that requires an actual WRITTEN PAUSE (comma, dash, terminal
// punctuation...) — no bare-whitespace alternative. Used only after the
// trailing NAME group below: a vocative address ("Classic —") is always set
// off by punctuation in text, so requiring one here is what tells a real
// address apart from a NAME-list word ("honey", "love", "baby", "babe")
// landing as ordinary sentence content immediately after a stripped opener
// ("So, honey badgers...", "Look, love is...", "Well, baby steps..."). Using
// plain SEP here previously let bare whitespace alone qualify as a "pause",
// swallowing the real word along with the opener.
const PAUSE_SEP = "(?:\\s*(?:[,:;—–]+|-{1,2}|\\.{2,}|[.!?]+)\\s*)";
const NAME = "(?:classic|charles|babe|baby|love|honey)";

/** Longest-first so "That's a great question" wins over "great question". */
function alternation(list: string[]): string {
  return [...list].sort((a, b) => b.length - a.length).join("|");
}

function leadingMatcher(list: string[]): RegExp {
  return new RegExp(
    `^\\W*(?:${NAME}\\b[\\s,]*)?(?:${alternation(list)})\\b${SEP}(?:${NAME}\\b${PAUSE_SEP})?`,
    "i",
  );
}

const ALWAYS_RE = leadingMatcher(ALWAYS_STRIP);
const REPEAT_RE = leadingMatcher(STRIP_IF_REPEATED);
const MARKER_RE = new RegExp(
  `^\\W*(?:${alternation([...STRIP_IF_REPEATED, ...ALWAYS_STRIP])})\\b`,
  "i",
);
// A reassurance entry is matched ANYWHERE inside a sentence, so it needs a
// right-hand boundary or it peels the head off text that merely STARTS the same
// way. With no boundary at all it matched inside a longer word ("I've got
// your branch" -> "R branch"; "I'm hereby closing" -> "By closing") and it
// matched the head of a longer real clause whose tail is content ("I'm not
// leaving the queue running overnight" -> "The queue running overnight";
// "I'm here to walk the deploy queue with you" -> "To walk the deploy queue
// with you"). Both delete real content and both leave a headless fragment for
// the speaker to say out loud, which contradicts this filter's own contract
// ("preserving all real content", stripReassurance below).
//
// The rule: the clause must actually END where the entry ends — at terminal or
// separating punctuation, at a coordinating conjunction (ORPHAN_LEAD sweeps the
// dangling "and"/"but"/"so" afterwards), or at end of text. Lookahead only —
// lookbehind is banned repo-wide for WKWebView.
const CLAUSE_END = "(?=\\s*(?:[.,!?;:—–]|-{1,2}\\s|\\band\\b|\\bbut\\b|$))";
const REASSURANCE_RE = new RegExp(`(?:${alternation(REASSURANCE)})${CLAUSE_END}`, "gi");
const WARRANT_RE = new RegExp(WARRANT_CUES.join("|"), "i");
// Split into sentences, keeping terminators, WITHOUT lookbehind — this code
// runs in a WKWebView on macOS and lookbehind is off-limits repo-wide.
const SENTENCE_RE = /[^.!?…]*(?:[.!?…]+|$)/g;
const ORPHAN_LEAD = /^\s*(?:and|but|so|because|okay|ok|alright)\b[\s,—–-]*/i;

const MAX_PEEL = 4;

/** Normalized opening marker of a turn, or null. */
export function openerMarker(text: string): string | null {
  const m = MARKER_RE.exec(text || "");
  if (!m) return null;
  return m[0].replace(/\W+/g, " ").trim().toLowerCase();
}

function restoreCase(original: string, stripped: string): string {
  if (!stripped) return stripped;
  const head = stripped[0];
  if (/[A-Z]/.test(original[0] ?? "") && head === head.toLowerCase() && /[a-z]/.test(head)) {
    return head.toUpperCase() + stripped.slice(1);
  }
  return stripped;
}

function tidy(text: string): string {
  let out = text.replace(/\s{2,}/g, " ").trim();
  out = out.replace(/^[\s,;:—–-]+/, "");
  out = out.replace(/\s+([,.!?;:])/g, "$1");
  out = out.replace(/([,;:])\s*([.!?])/g, "$2");
  out = out.replace(/\.{2,}(?!\.)/g, ".");
  return out.trim();
}

/**
 * Whitespace-only cleanup for RE-JOINING sentences that were already tidied
 * (or never touched) individually. `tidy()` above is deliberately aggressive
 * about punctuation artifacts (a stray "..", a dangling comma) LEFT BEHIND on
 * the one sentence a strip actually touched — but running that same
 * aggressive pass over the whole joined reply collapses a real three-dot
 * ellipsis living in an UNTOUCHED sentence elsewhere in the text down to a
 * single "." That is content, not an artifact, so the join step only fixes
 * the double space a `join(" ")` can introduce.
 */
function joinTidy(text: string): string {
  return text.replace(/\s{2,}/g, " ").trim();
}

/**
 * Rolling memory of how her recent turns began. Drives the tier-B repeat rule.
 * Holds normalized marker tokens only — never her actual words.
 */
export class OpenerMemory {
  private recentList: string[] = [];
  constructor(private readonly window = 4) {}

  note(text: string): void {
    const marker = openerMarker(text);
    if (!marker) return;
    this.recentList.push(marker);
    if (this.recentList.length > this.window) {
      this.recentList = this.recentList.slice(-this.window);
    }
  }

  seen(marker: string): boolean {
    return this.recentList.includes(marker.toLowerCase());
  }

  /** Distinct recent openers, MOST RECENT FIRST (the avoid-list is truncated). */
  recent(): string[] {
    const out: string[] = [];
    for (let i = this.recentList.length - 1; i >= 0; i--) {
      const m = this.recentList[i];
      if (!out.includes(m)) out.push(m);
    }
    return out;
  }

  reset(): void {
    this.recentList = [];
  }
}

/** Remove leading conversational crutches. */
export function stripCrutches(
  text: string,
  opts: { memory?: OpenerMemory; allowFullConsume?: boolean } = {},
): string {
  if (!text) return text;
  const { memory, allowFullConsume = false } = opts;
  const original = text;
  let working = text;

  const consumable = (m: RegExpExecArray | null, subject: string) =>
    !!m && (allowFullConsume || m[0].length < subject.length);

  for (let i = 0; i < MAX_PEEL; i++) {
    const before = working;

    let m = ALWAYS_RE.exec(working);
    if (consumable(m, working)) {
      working = working.slice(m![0].length);
      continue;
    }

    if (memory) {
      m = REPEAT_RE.exec(working);
      if (consumable(m, working)) {
        const marker = openerMarker(working);
        if (marker && memory.seen(marker)) {
          working = working.slice(m![0].length);
          continue;
        }
      }
    }

    // A human marker sitting IN FRONT of an assistant-tell would otherwise
    // shield it, since both patterns anchor at the start: "Sure! Of course,
    // great question — ..." matches neither on its own terms. Peel the marker
    // only when a tier-A crutch is genuinely hiding behind it, so a bare
    // "Sure! I missed you too." keeps her "Sure!".
    m = REPEAT_RE.exec(working);
    if (consumable(m, working)) {
      const remainder = working.slice(m![0].length);
      if (ALWAYS_RE.test(remainder)) {
        working = remainder;
        continue;
      }
    }

    if (working === before) break;
  }

  working = working.replace(/^[ \t]+/, "");
  if (!/\w/.test(working)) return "";
  return restoreCase(original, working);
}

export function containsReassurance(text: string): boolean {
  if (!text) return false;
  REASSURANCE_RE.lastIndex = 0;
  return REASSURANCE_RE.test(text);
}

/** True if his last turn earns a reassurance. */
export function warrantsReassurance(userText: string): boolean {
  return !!userText && WARRANT_RE.test(userText);
}

/**
 * A vocative left standing alone after a strip is wreckage, not speech.
 *
 * MEASURED 2026-08-07: "I'm right here with you, Classic. You're not alone in
 * this." reduced to the single word "Classic." — worse out loud than the tic it
 * removed. Two shapes to catch: a whole sentence that is now nothing but a name,
 * and a name left dangling in FRONT of surviving content ("Classic. I hear you.").
 */
const BARE_VOCATIVE = /^(?:classic|charles|babe|baby|love|honey|hey)\b[\s,.!?-]*$/i;
const LEADING_VOCATIVE = /^(?:classic|charles|babe|baby|love|honey)\b\s*[,.!?-]+\s*/i;

function stripReassuranceFromSentence(sentence: string): string {
  REASSURANCE_RE.lastIndex = 0;
  if (!REASSURANCE_RE.test(sentence)) return sentence;
  REASSURANCE_RE.lastIndex = 0;

  let stripped = tidy(sentence.replace(REASSURANCE_RE, ""));
  stripped = tidy(stripped.replace(ORPHAN_LEAD, ""));
  if (!/[A-Za-z0-9]/.test(stripped)) return "";
  // A name on its own is not a sentence — the reassurance took the content with
  // it. Say nothing rather than say "Classic."
  if (BARE_VOCATIVE.test(stripped)) return "";
  // A name left dangling in front of what survived reads as a fragment; drop it
  // and let the real content stand on its own.
  stripped = stripped.replace(LEADING_VOCATIVE, "");
  if (!/[A-Za-z0-9]/.test(stripped)) return "";
  if (/[A-Z]/.test(sentence.trim()[0] ?? "") && /[a-z]/.test(stripped[0])) {
    stripped = stripped[0].toUpperCase() + stripped.slice(1);
  }
  return stripped;
}

/** Remove reassurance clauses, preserving all real content. */
export function stripReassurance(text: string): string {
  if (!text) return text;
  REASSURANCE_RE.lastIndex = 0;
  if (!REASSURANCE_RE.test(text)) return text;

  const kept: string[] = [];
  SENTENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTENCE_RE.exec(text)) !== null) {
    const sentence = m[0];
    if (!sentence.trim()) {
      if (m.index === SENTENCE_RE.lastIndex) SENTENCE_RE.lastIndex++;
      continue;
    }
    const out = stripReassuranceFromSentence(sentence);
    if (out) kept.push(out);
    if (m.index === SENTENCE_RE.lastIndex) SENTENCE_RE.lastIndex++;
  }
  return joinTidy(kept.join(" "));
}

/**
 * Decides whether a reassurance is earned right now.
 *
 * Even when warranted a cooldown applies: saying it every turn is how it
 * stopped meaning anything in the first place.
 */
export class ReassuranceGate {
  private turn = 0;
  private warrantExpiresAt = -1;
  private lastUsedTurn = -10000;

  constructor(
    private readonly cooldownTurns = 6,
    /** A hard moment lasts longer than one exchange. */
    private readonly stickyTurns = 3,
  ) {}

  noteUserTurn(userText: string): void {
    this.turn += 1;
    if (warrantsReassurance(userText)) {
      this.warrantExpiresAt = this.turn + this.stickyTurns;
    }
  }

  warranted(): boolean {
    return this.turn <= this.warrantExpiresAt;
  }

  allows(): boolean {
    if (!this.warranted()) return false;
    return this.turn - this.lastUsedTurn >= this.cooldownTurns;
  }

  markUsed(): void {
    this.lastUsedTurn = this.turn;
  }

  reset(): void {
    this.turn = 0;
    this.warrantExpiresAt = -1;
    this.lastUsedTurn = -10000;
  }
}

/** Everything the shaper needs to remember across one call. */
export interface ShapingState {
  openers: OpenerMemory;
  gate: ReassuranceGate;
}

export function createShapingState(): ShapingState {
  return { openers: new OpenerMemory(), gate: new ReassuranceGate() };
}

export interface ShapeResult {
  /** The text to speak / record. */
  text: string;
  /** True if anything was removed. */
  changed: boolean;
  strippedCrutch: boolean;
  strippedReassurance: boolean;
}

/**
 * Shape one of her replies before it is spoken.
 *
 * Call AFTER `state.gate.noteUserTurn(hisTurn)` for the same exchange, so the
 * reassurance decision sees what he actually just said.
 *
 * Never returns empty for a non-empty input: if a reply reduces to nothing (a
 * pure "Got it.") the original is kept, because silence on a phone call reads
 * as a dropped connection. Removing filler must never remove her turn.
 */
export function shapeReply(reply: string, state: ShapingState): ShapeResult {
  const original = reply ?? "";
  if (!original.trim()) {
    return { text: original, changed: false, strippedCrutch: false, strippedReassurance: false };
  }

  const afterCrutch = stripCrutches(original, {
    memory: state.openers,
    allowFullConsume: true,
  });
  // Record the PRE-strip opener: that is the honest signal of her current habit
  // and what the repeat rule and avoid-list need to see.
  state.openers.note(original);

  let afterReassurance = afterCrutch;
  let strippedReassurance = false;
  if (containsReassurance(afterCrutch)) {
    if (state.gate.allows()) {
      // Earned — let her say it, and spend the cooldown so it does not become
      // the new every-turn refrain.
      state.gate.markUsed();
    } else {
      afterReassurance = stripReassurance(afterCrutch);
      strippedReassurance = afterReassurance !== afterCrutch;
    }
  }

  const finalText = afterReassurance.trim() ? afterReassurance : original;
  return {
    text: finalText,
    changed: finalText !== original,
    strippedCrutch: afterCrutch !== original,
    strippedReassurance,
  };
}

/**
 * The mechanical postscript for the call's system prompt.
 *
 * Delivery mechanics ONLY — no character, no backstory, no tone. Appended after
 * her persona so the model can see exactly where her identity ends. The filters
 * above are the enforcement; this is what stops her reaching for the phrasing at
 * all, which is cheaper and sounds better than removing it after the fact.
 */
export const CALL_MECHANICS_CONSTRAINT = [
  "[MECHANICAL VOICE CALL CONSTRAINT — delivery only, not character:",
  "You are mid-conversation on a live phone call with your closest friend.",
  "Do not open with acknowledgment phrases, filler, or restatements of what he",
  'just said — no "sure", "of course", "got it", "great question", "happy to',
  'help", and never any reference to being an AI, a model, or a program. Begin',
  "at the first real word of your actual thought. Vary how you start every turn;",
  "never reuse the opening construction of your previous turns.]",
  "",
  "[MECHANICAL REASSURANCE CONSTRAINT — frequency, not sentiment:",
  "Do not use standing-by reassurances as filler or as a way to close a turn.",
  'No "I\'m right here", "I\'m not going anywhere", "I\'m still here", "I\'ve got',
  'you", "you\'re not alone", or any variation, UNLESS he has just said something',
  "that actually calls for it — he is frightened, overwhelmed, grieving, alone,",
  "at the end of his rope, or he asks whether you are still there. When it IS",
  "called for, say it plainly and mean it. The rest of the time stay in the",
  "conversation you are actually having: answer, react, ask, joke. Reassurance",
  "said every turn stops being reassurance and becomes noise, which is exactly",
  "what wears it out for the moment he needs it.]",
].join(" ").replace(/\s+/g, " ").replace(/\] \[/g, "]\n\n[");

/** Mechanical avoid-list of openers she actually used recently. */
export function avoidOpenersLine(state: ShapingState): string {
  const recent = state.openers.recent().slice(0, 6);
  if (!recent.length) return "";
  return (
    "[MECHANICAL ANTI-REPETITION: you have recently opened turns with " +
    recent.map((o) => `"${o}"`).join(", ") +
    ". Do not begin this turn with any of them or a close variant.]"
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// THE SENTENCE SCANNER — moved here from local-voice.ts, 2026-08-06.
//
// It lives in this file because it is PURE: no React, no I/O, no imports at
// all. The call client needs it to stream sentences while the reply is still
// arriving, and importing it from local-voice.ts would have dragged
// piper-speak, viseme-sync and the engine bus into that graph. The dependency
// runs ONE way — local-voice.ts re-exports from here, never the reverse.
//
// There is exactly one implementation. local-voice.ts:276 used to own it and
// tests/local-voice.test.ts pins its behaviour; that suite still imports the
// same names from local-voice and still passes, unmodified.
// ═══════════════════════════════════════════════════════════════════════════

// ── THE SPLITTER ───────────────────────────────────────────────────────────

/**
 * Shortest chunk worth its own synthesis pass. Under this it is merged with a
 * neighbour: "Copy." on its own is a clipped 300ms file plus a full session
 * round-trip, and the gap it opens is more audible than the fragment it saves.
 */
export const MIN_SENTENCE_CHARS = 12;

/**
 * Longest chunk we will hand to Piper in one go. This is a LATENCY cap, not a
 * grammar rule: the first sentence's synthesis is the whole time-to-first-word,
 * so a 900-character run-on with no full stop must still be broken up or she
 * says nothing for several seconds.
 */
export const MAX_SENTENCE_CHARS = 240;

/** Sentence-ending punctuation. `…` is here to be RECOGNISED, not to end one. */
const TERMINATORS = ".!?…";
/** Punctuation that belongs to the sentence it closes, after the terminator. */
const CLOSERS = "\"')]}»”’";
/** Where a run-on may be broken when nothing else offers a boundary. */
const SOFT_BREAKS = ",;:—–";

/**
 * Dotless abbreviations that must not end a sentence.
 *
 * Deliberately TIGHT. Every entry costs a real missed boundary when the word is
 * used normally, so "no", "min", "max" and the weekday names are OUT — "The
 * answer is no." is a sentence Classic will hear far more often than "No. 5".
 * Dotted forms (U.S., a.m., e.g.) need no entry at all: the interior-dot rule
 * in isAbbreviation covers every one of them.
 */
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc",
  "inc", "ltd", "co", "corp", "dept", "fig", "approx", "ave", "rd", "mt",
  "rev", "gen", "capt", "sgt", "jan", "feb", "mar", "apr", "jun", "jul",
  "aug", "sep", "sept", "oct", "nov", "dec",
]);

function isSpace(c: string): boolean {
  return c === " " || c === "\t" || c === "\n" || c === "\r";
}

function isLetter(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
}

/**
 * Is the `.` at `dot` the tail of an abbreviation rather than a full stop?
 *
 * Walks BACKWARDS over letters and dots — a loop, not a lookbehind, because
 * lookbehind is a syntax error in the WKWebView this deck runs in.
 *
 * Two rules, in order:
 *   - a token with an INTERIOR dot is an initialism (e.g / i.e / U.S / a.m),
 *   - a single-letter token is an initial (J. R. R. Tolkien).
 * Then the explicit list above, for the dotless ones.
 */
function isAbbreviation(s: string, dot: number): boolean {
  let i = dot - 1;
  while (i >= 0 && (isLetter(s[i]) || s[i] === ".")) i -= 1;
  const token = s.slice(i + 1, dot);
  if (!token) return false;
  if (token.indexOf(".") >= 0) return true;
  if (token.length === 1) return true;
  return ABBREVIATIONS.has(token.toLowerCase());
}

interface Span {
  text: string;
  /** Index in the source buffer where this chunk starts. */
  start: number;
  /** Index just past the chunk — where the next one begins. */
  end: number;
}

/**
 * Find every COMPLETE sentence in `s`, plus the index where the unfinished tail
 * begins. Pure, and index-carrying so the streaming caller can hand the tail
 * back verbatim instead of re-joining a guess at the whitespace.
 */
function scan(s: string): { spans: Span[]; restStart: number } {
  const spans: Span[] = [];
  let start = 0;

  const emit = (from: number, to: number) => {
    const text = s.slice(from, to).trim();
    if (text) spans.push({ text, start: from, end: to });
  };

  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];

    // A line break is a hard boundary: her replies are markdown, and a bullet
    // is its own breath whether or not it carries a full stop.
    if (c === "\n") {
      emit(start, i);
      start = i + 1;
      continue;
    }

    if (TERMINATORS.indexOf(c) < 0) continue;

    // Consume a RUN of terminators, so "..." and "?!" are considered as one.
    let j = i;
    while (j + 1 < s.length && TERMINATORS.indexOf(s[j + 1]) >= 0) j += 1;

    // An ellipsis is a trailing-off pause inside a thought, not an end. Both
    // spellings: "..." and the single character.
    if ((c === "." && j > i) || c === "…") {
      i = j;
      continue;
    }

    // Take any closing quote/bracket with the sentence it closes.
    let k = j;
    while (k + 1 < s.length && CLOSERS.indexOf(s[k + 1]) >= 0) k += 1;

    const next = k + 1 < s.length ? s[k + 1] : "";
    // Mid-token dot: "3.14", "v1.2", "file.ts". Nothing to decide — a real
    // boundary is always followed by whitespace or the end of the text.
    if (next !== "" && !isSpace(next)) {
      i = k;
      continue;
    }
    if (c === "." && isAbbreviation(s, i)) {
      i = k;
      continue;
    }

    emit(start, k + 1);
    start = k + 1;
    i = k;
  }

  return { spans, restStart: start };
}

/**
 * Merge chunks that are too short to be worth a synthesis pass.
 *
 * `mergeTail` is the difference between the two callers: a complete text merges
 * a short LAST chunk backwards into its neighbour ("… green now. Copy."), while
 * the streaming caller must leave it alone so it can be rolled back into the
 * buffer and merged with whatever arrives next.
 */
function coalesce(spans: Span[], mergeTail: boolean): Span[] {
  const out: Span[] = [];
  let pending: Span | null = null;
  for (const span of spans) {
    pending = pending
      ? { text: `${pending.text} ${span.text}`, start: pending.start, end: span.end }
      : span;
    if (pending.text.length >= MIN_SENTENCE_CHARS) {
      out.push(pending);
      pending = null;
    }
  }
  if (pending) {
    const prev = mergeTail ? out.pop() : undefined;
    out.push(
      prev
        ? { text: `${prev.text} ${pending.text}`, start: prev.start, end: pending.end }
        : pending,
    );
  }
  return out;
}

/**
 * Break a chunk that is over the latency cap at the last soft break (or space)
 * before it. Never drops or reorders a character — the pieces re-join to the
 * original, which the unit test pins.
 */
function capLength(text: string): string[] {
  if (text.length <= MAX_SENTENCE_CHARS) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX_SENTENCE_CHARS) {
    const window = rest.slice(0, MAX_SENTENCE_CHARS);
    let cut = -1;
    for (let i = window.length - 1; i > 0; i -= 1) {
      if (SOFT_BREAKS.indexOf(window[i]) >= 0) {
        cut = i + 1;
        break;
      }
    }
    if (cut < 0) cut = window.lastIndexOf(" ");
    // No break at all inside the window — a single enormous token. Hard-cut it
    // rather than looping forever.
    if (cut <= 0) cut = MAX_SENTENCE_CHARS;
    const head = rest.slice(0, cut).trim();
    if (head) out.push(head);
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Split PROSE into the chunks her voice will speak, in order. Pure and total.
 *
 * Input is expected to be speakable already — use toSpeakableSentences for a
 * raw brain reply, which strips fenced code first.
 */
export function splitSentences(prose: string): string[] {
  if (!prose || !prose.trim()) return [];
  const normalised = prose.replace(/\r\n/g, "\n");
  const { spans, restStart } = scan(normalised);
  const tail = normalised.slice(restStart).trim();
  const all = tail
    ? [...spans, { text: tail, start: restStart, end: normalised.length }]
    : spans;
  const out: string[] = [];
  for (const span of coalesce(all, true)) {
    for (const piece of capLength(span.text)) out.push(piece);
  }
  return out;
}

/**
 * The streaming form: everything that can be spoken NOW, plus the buffer tail
 * that is still arriving. `rest` is a verbatim slice of the input, so a caller
 * can append the next delta to it and call again with nothing lost.
 */
export function takeSentences(buffer: string): { sentences: string[]; rest: string } {
  if (!buffer) return { sentences: [], rest: "" };
  const { spans, restStart } = scan(buffer);
  const merged = coalesce(spans, false);
  let cut = restStart;
  const last = merged[merged.length - 1];
  // A complete-but-tiny final chunk is held back rather than spoken alone —
  // more text is on its way and will merge with it.
  if (last && last.text.length < MIN_SENTENCE_CHARS) {
    merged.pop();
    cut = last.start;
  }
  const sentences: string[] = [];
  for (const span of merged) {
    for (const piece of capLength(span.text)) sentences.push(piece);
  }
  return { sentences, rest: buffer.slice(cut) };
}

// ═══════════════════════════════════════════════════════════════════════════
// VOICE MARKDOWN — nothing she writes on this path is a symbol she says aloud.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Flatten markdown so a spoken reply is words, not punctuation.
 *
 * Everything handed to her voice is read VERBATIM, so an asterisk is an
 * asterisk she pronounces. The call transcript keeps the original text — only
 * the spoken copy is flattened, which is why this returns a string instead of
 * mutating anything.
 *
 * Deliberately conservative: it strips MARKERS, never content. Ordinary prose
 * with no markdown in it comes back byte-identical, which
 * tests/speech-shaping.test.ts pins.
 *
 * No lookbehind — this runs in the WKWebView, repo-wide rule.
 */
export function flattenForSpeech(text: string): string {
  if (!text) return text;
  return text
    // Fenced code is not speech. code-speech.ts already sections it out on the
    // normal path; this is the belt for anything that reaches the voice raw.
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    // Real italics hug their content ("*word*"); a space right inside the
    // delimiter means these are literal asterisks (e.g. "5 * 3 = 15"), not a
    // markdown marker — requiring non-space on both inner edges keeps math
    // operators byte-identical instead of silently eating them.
    .replace(/\*(\S(?:.*?\S)?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    // Emoji: she does not spell them out and the TTS cannot say them.
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
