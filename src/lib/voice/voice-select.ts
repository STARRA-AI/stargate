/**
 * STARRA voice selection — ONE VOICE (Classic's order, 2026-07-30): she is
 * "eve", the British female voice of the live call (api/realtime) and of xAI
 * TTS (api/tts). Web Speech here is the LAST-RESORT availability fallback, and
 * it must approximate the same person, never a different character:
 *   1. Operator's stored pick (Settings → Voice)
 *   2. British English female voices (Google UK English Female, Kate, Serena…)
 *   3. Any female-sounding English voice
 *   4. Japanese female voices (Kyoko, O-Ren) — deep fallback only
 * Delivery: slightly higher pitch, measured unhurried rate.
 */

export const STARRA_PITCH = 1.08;
export const STARRA_RATE = 0.95;

const STORAGE_KEY = "starra_voice_uri";

/**
 * Sentinel value meaning "use Ara (xAI TTS)" — the primary voice, handled in
 * speak.ts, not by Web Speech. "auto" means let Web Speech auto-pick. Anything
 * else is a concrete Web Speech voiceURI.
 */
export const ARA_VOICE_ID = "ara";
export const AUTO_VOICE_ID = "auto";

/** Ara is the default: selected unless the operator explicitly picked otherwise. */
export function isAraSelected(): boolean {
  const s = getStoredVoiceUri();
  return s === null || s === ARA_VOICE_ID;
}

/** A concrete Web Speech voice was chosen (not Ara, not auto) → skip Ara + Piper. */
export function isSpecificWebSpeechVoice(): boolean {
  const s = getStoredVoiceUri();
  return s !== null && s !== ARA_VOICE_ID && s !== AUTO_VOICE_ID;
}

const GB_FEMALE = [
  /google uk english female/i,
  /\bkate\b/i,
  /\bserena\b/i,
  /\bmartha\b/i,
  /\bstephanie\b/i,
  /\bhazel\b/i,
  /\bsonia\b/i,
  /\blibby\b/i,
];

const JA_FEMALE = [/\bkyoko\b/i, /o-?ren/i, /\bnanami\b/i, /\bayumi\b/i];

const EN_FEMALE_HINTS = [
  /female/i,
  /\bsamantha\b/i,
  /\bvictoria\b/i,
  /\bkaren\b/i,
  /\bmoira\b/i,
  /\btessa\b/i,
  /\bfiona\b/i,
  /\bava\b/i,
  /\ballison\b/i,
  /\bsusan\b/i,
  /\bzira\b/i,
  /\baria\b/i,
];

export function getStoredVoiceUri(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(STORAGE_KEY);
}

export function setStoredVoiceUri(uri: string | null) {
  if (typeof window === "undefined") return;
  if (uri) localStorage.setItem(STORAGE_KEY, uri);
  else localStorage.removeItem(STORAGE_KEY);
}

export function listVoices(): SpeechSynthesisVoice[] {
  if (typeof window === "undefined" || !window.speechSynthesis) return [];
  return window.speechSynthesis.getVoices();
}

function firstMatch(
  voices: SpeechSynthesisVoice[],
  patterns: RegExp[],
  langPrefix?: string,
): SpeechSynthesisVoice | null {
  for (const p of patterns) {
    const hit = voices.find(
      (v) =>
        p.test(v.name) && (!langPrefix || v.lang.toLowerCase().startsWith(langPrefix)),
    );
    if (hit) return hit;
  }
  return null;
}

export function pickStarraVoice(
  voices: SpeechSynthesisVoice[] = listVoices(),
): SpeechSynthesisVoice | null {
  if (!voices.length) return null;

  const storedUri = getStoredVoiceUri();
  // "ara"/"auto" are engine sentinels, not Web Speech URIs — fall through to auto-pick.
  if (storedUri && storedUri !== ARA_VOICE_ID && storedUri !== AUTO_VOICE_ID) {
    const stored = voices.find((v) => v.voiceURI === storedUri);
    if (stored) return stored;
  }

  // 1. British female
  const gb =
    firstMatch(voices, GB_FEMALE, "en-gb") ?? firstMatch(voices, GB_FEMALE);
  if (gb) return gb;

  // 2. en-GB anything female-sounding
  const gbAny = voices.find(
    (v) =>
      v.lang.toLowerCase().startsWith("en-gb") &&
      EN_FEMALE_HINTS.some((p) => p.test(v.name)),
  );
  if (gbAny) return gbAny;

  // 3. Any female-sounding English voice — an English female approximates the
  // call voice (eve, en-GB) far closer than a Japanese voice reading English,
  // so this now outranks the old Japanese rung (one person, one voice).
  const enFemale = voices.find(
    (v) =>
      v.lang.toLowerCase().startsWith("en") &&
      EN_FEMALE_HINTS.some((p) => p.test(v.name)),
  );
  if (enFemale) return enFemale;

  // 4. Japanese female — deep fallback only, when no English female exists.
  const ja =
    firstMatch(voices, JA_FEMALE, "ja") ?? firstMatch(voices, JA_FEMALE);
  if (ja) return ja;

  return voices.find((v) => v.lang.toLowerCase().startsWith("en")) ?? voices[0];
}

/** Apply STARRA's voice + delivery to an utterance. */
export function applyStarraVoice(u: SpeechSynthesisUtterance) {
  const voice = pickStarraVoice();
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  }
  u.pitch = STARRA_PITCH;
  u.rate = STARRA_RATE;
}

/** Voices load async in some browsers — resolves once the list is ready. */
export function voicesReady(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      resolve([]);
      return;
    }
    const now = window.speechSynthesis.getVoices();
    if (now.length) {
      resolve(now);
      return;
    }
    const onChange = () => {
      window.speechSynthesis.removeEventListener("voiceschanged", onChange);
      resolve(window.speechSynthesis.getVoices());
    };
    window.speechSynthesis.addEventListener("voiceschanged", onChange);
    setTimeout(onChange, 1500);
  });
}
