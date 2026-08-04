/**
 * Code in a voice world — pure decisions (the spicy-mode.ts idiom: logic here,
 * tested; the components only wire it).
 *
 * `isCodeAsk` — does a TYPED line ask for code/config/commands? Used by
 * VoiceCallOverlay.handleSend to route the ask to the BRAIN even mid-call,
 * exactly like the `mcp`/`browse` commands: the realtime session answers in
 * AUDIO, and an audio stream cannot carry a fenced, copyable block. The
 * brain's reply streams into the same chat column, where the renderer
 * sections every fence off with its own Copy (src/lib/markdown.tsx CodeBlock).
 * A false positive costs one typed-and-spoken reply instead of a purely
 * spoken one; a false negative costs a retype — so the word list leans
 * generous but avoids everyday-speech collisions ("class", "method").
 *
 * `speakableText` — what TTS may SAY of a brain reply: her prose only, never
 * the fence contents. Fence detection is line-anchored `^```` — the SAME rule
 * markdown.tsx's toBlocks uses, so what the deck sections off and what the
 * voice skips can never disagree (an unterminated fence mid-stream is code in
 * both). No regex lookbehind anywhere — macOS 12 WebKit.
 */

const CODE_WORDS =
  /\b(code|coding|script|snippet|function|regex|sql|query|json|yaml|html|css|javascript|typescript|python|bash|shell|terminal|command|cli|component|hook|endpoint|curl|docker|dockerfile|git|npm|npx|pip|config|configuration|env var|environment variable)\b/i;

const FILE_EXT = /\.(py|js|jsx|ts|tsx|mjs|cjs|sh|zsh|css|html|json|ya?ml|sql|toml|env|conf|md)\b/i;

/** Does a typed line ask for code, a command, or a config? */
export function isCodeAsk(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // He's already talking in code: a fence or inline backtick token.
  if (t.includes("```") || /`[^`\n]+`/.test(t)) return true;
  return CODE_WORDS.test(t) || FILE_EXT.test(t);
}

/**
 * Reduce a brain reply to what her voice should say: prose kept, fenced
 * blocks dropped (unterminated trailing fence included), inline backticks
 * read silently. A reply that was ONLY code still gives her one true line to
 * say instead of dead air.
 */
export function speakableText(reply: string): string {
  const lines = reply.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  let inFence = false;
  let hadCode = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      hadCode = true;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  const prose = kept
    .join("\n")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/\n{2,}/g, "\n")
    .trim();
  if (!prose && hadCode) return "It's in the chat.";
  return prose;
}
