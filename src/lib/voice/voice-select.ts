/**
 * STARRA voice selection — operator hears an Asian woman with a Japanese
 * or British accent. Preference order:
 *   1. Operator's stored pick (Settings → Voice)
 *   2. British English female voices (Google UK English Female, Kate, Serena, Martha…)
 *   3. Japanese female voices (Kyoko, O-Ren) speaking the reply
 *   4. Any female-sounding English voice
 * Delivery: slightly higher pitch, measured rate — calm, dry, precise.
 */

export const STARRA_PITCH = 1.08;
export const STARRA_RATE = 0.95;

const STORAGE_KEY = "starra_voice_uri";

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
  if (storedUri) {
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

  // 3. Japanese female
  const ja =
    firstMatch(voices, JA_FEMALE, "ja") ?? firstMatch(voices, JA_FEMALE);
  if (ja) return ja;

  // 4. Any female-sounding English voice
  const enFemale = voices.find(
    (v) =>
      v.lang.toLowerCase().startsWith("en") &&
      EN_FEMALE_HINTS.some((p) => p.test(v.name)),
  );
  if (enFemale) return enFemale;

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
  // #region agent log
  fetch("http://127.0.0.1:7335/ingest/492eaea3-719f-4f1b-a6a4-532369c1efe1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "f8c9f7",
    },
    body: JSON.stringify({
      sessionId: "f8c9f7",
      location: "voice-select.ts:applyStarraVoice",
      message: "voice applied",
      data: {
        voiceName: voice?.name ?? null,
        voiceLang: voice?.lang ?? null,
        storedUri: getStoredVoiceUri(),
        voiceCount: listVoices().length,
        pitch: STARRA_PITCH,
        rate: STARRA_RATE,
      },
      timestamp: Date.now(),
      hypothesisId: "H-V1",
      runId: "pre",
    }),
  }).catch(() => {});
  // #endregion
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
