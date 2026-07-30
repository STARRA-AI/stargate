/**
 * STARRA ENGINE — secret masking + redaction.
 *
 * CLIENT-SAFE: this module is pure. It reads no env, touches no disk, and holds
 * no credential of its own, so the Options panel may import it to render a mask.
 *
 * It is the last line before a key reaches a screen, a log or an error string.
 * Two layers, on purpose:
 *   1. VALUE redaction — the caller passes the secrets it actually resolved
 *      (see collectSecretValues in ./config). This catches opaque keys that
 *      match no known shape.
 *   2. SHAPE redaction — provider key patterns, so a key still gets scrubbed on
 *      a path where nobody remembered to pass the value list.
 *
 * macOS 12 / WKWebView: no regex lookbehind anywhere in here.
 */

const MASK_CHAR = "•"; // •
const MASK_BODY = 8;
/** Below this, a value is short enough that showing 4 chars would reveal it. */
const MIN_REVEAL_LEN = 8;

/** Provider key shapes. Bounded quantifiers only — no lookbehind, no nesting. */
const SHAPE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9\-_]{16,}/g, "[REDACTED_KEY]"],
  [/\bsk-[A-Za-z0-9\-_]{16,}/g, "[REDACTED_KEY]"],
  [/\bgsk_[A-Za-z0-9\-_]{16,}/g, "[REDACTED_KEY]"],
  [/\bxai-[A-Za-z0-9\-_]{16,}/g, "[REDACTED_KEY]"],
  [/\br8_[A-Za-z0-9\-_]{16,}/g, "[REDACTED_KEY]"],
  [/\bhf_[A-Za-z0-9]{16,}/g, "[REDACTED_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "[REDACTED_KEY]"],
  [/\bAIza[0-9A-Za-z\-_]{20,}/g, "[REDACTED_KEY]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_KEY]"],
  [/Bearer\s+[A-Za-z0-9._\-~+/=]{8,}/gi, "Bearer [REDACTED_KEY]"],
];

/** Header-ish `name: value` / `name=value` assignments of a credential. */
const ASSIGNMENT_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(x-api-key|api[_-]?key|apikey|token|secret|password|passwd|key_override|keyoverride)\b(\s*[:=]\s*)\S+/gi,
    "$1$2[REDACTED_KEY]",
  ],
];

/** Query-string values are never safe to keep — URLs end up in logs. */
const QUERY_VALUE_RULE: readonly [RegExp, string] = [
  /([?&][A-Za-z0-9_\-]{1,40}=)[^&\s]{8,}/g,
  "$1[REDACTED_KEY]",
];

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** True when a credential is present. Never reveals anything about it. */
export function hasKey(value: string | null | undefined): boolean {
  return clean(value) !== null;
}

/**
 * The last 4 characters of a credential — the only fragment allowed to leave
 * the server. Returns null for absent values and for values short enough that
 * 4 characters would be a meaningful share of the secret.
 */
export function last4(value: string | null | undefined): string | null {
  const v = clean(value);
  if (!v || v.length < MIN_REVEAL_LEN) return null;
  return v.slice(-4);
}

/**
 * Display form of a credential: a FIXED-WIDTH run of dots plus the last 4.
 * Fixed width matters — a variable-width mask leaks the key's length.
 */
export function maskKey(value: string | null | undefined): string | null {
  const v = clean(value);
  if (!v) return null;
  const tail = last4(v);
  if (!tail) return MASK_CHAR.repeat(MASK_BODY + 4);
  return MASK_CHAR.repeat(MASK_BODY) + tail;
}

/** Longest-first so a secret that contains another is replaced whole. */
function usableSecrets(secrets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of secrets) {
    const v = clean(s);
    if (v && v.length >= MIN_REVEAL_LEN) out.add(v);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

function stringify(input: unknown): string {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return input;
  if (input instanceof Error) {
    return input.message ? `${input.name}: ${input.message}` : input.name;
  }
  if (typeof input === "object") {
    try {
      const seen = new WeakSet<object>();
      return JSON.stringify(input, (_k, v) => {
        if (v && typeof v === "object") {
          if (seen.has(v as object)) return "[circular]";
          seen.add(v as object);
        }
        return v as unknown;
      }) ?? String(input);
    } catch {
      return "[unserializable]";
    }
  }
  try {
    return String(input);
  } catch {
    return "[unprintable]";
  }
}

/**
 * Scrub credentials out of anything before it is logged, stored or rendered.
 * Total function: any input shape, never throws.
 */
export function redactSecrets(input: unknown, secrets: readonly string[] = []): string {
  let out = stringify(input);
  if (!out) return out;
  for (const value of usableSecrets(secrets)) {
    out = out.split(value).join("[REDACTED_KEY]");
  }
  for (const [pattern, replacement] of SHAPE_RULES) {
    out = out.replace(pattern, replacement);
  }
  for (const [pattern, replacement] of ASSIGNMENT_RULES) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(QUERY_VALUE_RULE[0], QUERY_VALUE_RULE[1]);
  return out;
}

/**
 * Redacted message for ANY thrown value — including the unexpected-exception
 * handlers, which is exactly where keys have historically escaped.
 */
export function safeErrorMessage(err: unknown, secrets: readonly string[] = []): string {
  const raw = redactSecrets(err, secrets);
  return raw.length > 0 ? raw.slice(0, 400) : "unknown error";
}

/**
 * A URL that is safe to log: credentials in the userinfo or in ANY query value
 * are stripped, host and path kept so a probe failure is still diagnosable.
 */
export function redactUrl(url: string, secrets: readonly string[] = []): string {
  const input = typeof url === "string" ? url : "";
  try {
    const parsed = new URL(input);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    for (const key of [...parsed.searchParams.keys()]) {
      const v = parsed.searchParams.get(key) ?? "";
      if (v.length >= MIN_REVEAL_LEN) parsed.searchParams.set(key, "[REDACTED_KEY]");
    }
    return redactSecrets(parsed.toString(), secrets);
  } catch {
    return redactSecrets(input, secrets);
  }
}
