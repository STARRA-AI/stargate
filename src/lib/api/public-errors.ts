/**
 * Turn any thrown value into a string that is safe to hand to the internet.
 *
 * WHY: /api/mcp and /api/voice-tools are reachable from the public internet
 * because xAI's servers must call them (src/middleware.ts:12 lists both as
 * public prefixes). Both used to return `String(err)` verbatim. A filesystem
 * error names absolute paths — and therefore the machine and the operator; an
 * upstream error can carry a provider key. `redactSecrets` already existed and
 * was applied on the LLM lane (src/lib/llm/hosted.ts:321,326,355); it was
 * simply never applied here.
 *
 * Errors still SAY something: a public route that returns nothing is the mute
 * call all over again, just quieter. The basename survives so she can still
 * name what failed.
 *
 * NO LOOKBEHIND anywhere in this file — the repo-wide WKWebView rule.
 */
import { redactSecrets } from "@/lib/engine/redact";

const MAX = 200;

/** Two or more path segments in a row — an absolute path, not a bare word. */
const ABSOLUTE_PATH = /(?:\/[\w.\-@]+){2,}/g;
/** Any long opaque run that survived the shape rules. Keys look like this. */
const LONG_OPAQUE_RUN = /\b[A-Za-z0-9_-]{24,}\b/g;

export function safePublicError(err: unknown, opts?: { maxLen?: number }): string {
  const limit = opts?.maxLen ?? MAX;
  const base = err instanceof Error ? err.message : String(err ?? "unknown error");
  let out = redactSecrets(base);
  // Absolute paths: keep the basename so the message stays diagnostic.
  out = out.replace(ABSOLUTE_PATH, (m) => `…/${m.split("/").pop() ?? ""}`);
  // Anything key-shaped that redactSecrets did not already catch.
  out = out.replace(LONG_OPAQUE_RUN, "[redacted]");
  // A stack must never survive.
  out = (out.split("\n")[0] ?? out).trim();
  if (!out) out = "unknown error";
  return out.length > limit ? out.slice(0, Math.max(1, limit - 1)) + "…" : out;
}
