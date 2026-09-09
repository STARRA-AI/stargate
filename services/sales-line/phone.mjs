/**
 * E.164 normalisation.
 *
 * Twilio requires `+16154374490`. The Twilio console DISPLAYS the same number as
 * `(615) 437-4490`, so that is the form that gets copied into config, and it
 * fails at dial time with an error that reads like a bad number rather than a
 * bad format. Normalise the unambiguous US shapes; refuse everything else rather
 * than dial a number we guessed at.
 */
export function toE164(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = raw.trim();
  if (/^\+[1-9]\d{7,14}$/.test(t)) return t;
  const d = t.replace(/\D/g, "");
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  return null;
}
