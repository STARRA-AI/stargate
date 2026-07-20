/**
 * Secret redaction before memory / logs / feed.
 * Two layers: structural regexes + known env secret values.
 * Original implementation of the jarvis *pattern* — no jarvis code.
 */

const RULES: [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g, "[REDACTED_ANTHROPIC_KEY]"],
  [/\bsk-[A-Za-z0-9\-_]{20,}\b/g, "[REDACTED_API_KEY]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GH_TOKEN]"],
  [/\bAIza[0-9A-Za-z_\-]{30,}\b/g, "[REDACTED_GOOGLE_KEY]"],
  [/\bxox[abpcrs]-[A-Za-z0-9\-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]"],
  [/\b[rps]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, "[REDACTED_STRIPE_KEY]"],
  [/\bgsk_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GROQ_KEY]"],
  [/\btvly-[A-Za-z0-9\-]{16,}\b/g, "[REDACTED_TAVILY_KEY]"],
  [
    /\beyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/g,
    "[REDACTED_JWT]",
  ],
  [/Authorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer [REDACTED]"],
  [/Authorization:\s*Basic\s+[A-Za-z0-9+/=]+/gi, "Authorization: Basic [REDACTED]"],
  [
    /\b(pass(?:word|wd)?|secret|token|api[_\-]?key|apikey|(?:access|refresh|session|oauth)[_\-]?(?:token|key|id)?|auth)\s*[:=]\s*\S+/gi,
    "$1=[REDACTED]",
  ],
  [/\b(?:\d[ \-]?){13,19}\b/g, "[REDACTED_CARD]"],
  [/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]"],
  [/\b[0-9A-Fa-f]{40,}\b/g, "[REDACTED_HEX]"],
];

const ENV_SECRET_NAMES = [
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "GEMINI_API_KEY",
  "XAI_API_KEY",
  "BRAVE_API_KEY",
  "TAVILY_API_KEY",
  "HIGGSFIELD_API_KEY",
  "OPENAI_API_KEY",
  "MULTICA_TOKEN",
  "GITHUB_TOKEN",
  "OPEN_COLLECTIVE_API_KEY",
  "AIAS_API_KEY",
  "AIASSIST_API_KEY",
  "OPENALICE_ALPACA_KEY_ID",
  "OPENALICE_ALPACA_SECRET_KEY",
] as const;

function knownEnvSecrets(): string[] {
  return ENV_SECRET_NAMES.map((n) => process.env[n] ?? "")
    .filter((v) => v.length >= 8)
    .sort((a, b) => b.length - a.length);
}

/**
 * Scrub secrets from text before persistence or display.
 * Preserves newlines; caps length.
 */
export function redact(text: string, maxLen = 12_000): string {
  if (!text) return text;
  let out = text;
  for (const value of knownEnvSecrets()) {
    out = out.split(value).join("[REDACTED_ENV_SECRET]");
  }
  for (const [pattern, repl] of RULES) {
    out = out.replace(pattern, repl);
  }
  if (out.length > maxLen) {
    out = `${out.slice(0, maxLen)}\n[...truncated by redaction cap]`;
  }
  return out;
}
