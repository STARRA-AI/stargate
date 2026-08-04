/**
 * Private lane — command parser.
 *
 * Pure, dependency-free, and importable from the client (the Bridge uses it to
 * decide whether a turn is private BEFORE it renders anything). Because it may
 * run in WKWebView on macOS 12, this file must contain NO regex lookbehind
 * assertions — Safari on that OS throws a SyntaxError at parse time and takes
 * the whole bundle down with it. (tests/private-lane.test.ts greps this file
 * for the byte sequence, so do not write one even inside a comment.) Lookahead
 * is fine; none is needed here.
 *
 * Grammar (case-insensitive on the `private` prefix and the subcommand only):
 *
 *   private <ask>          | private: <ask>          -> { kind: "chat",   text }
 *   private ingest <path>  | private: ingest <path>  -> { kind: "ingest", path }
 *   private docs           | private: docs           -> { kind: "docs" }
 *
 * The prefix must be followed by whitespace or a colon, so `privateer stories`
 * and `private-gpt is running` are NOT private commands. Anything after the
 * prefix that is not a recognized subcommand is a private chat ask — a turn
 * that opens with `private` never escapes the local lane.
 */

export type PrivateCommand =
  | { kind: "chat"; text: string }
  | { kind: "ingest"; path: string }
  | { kind: "docs" };

/**
 * `private` + (a colon, or at least one space) + the rest of the line.
 * No lookbehind/lookahead. `[\s\S]` (not `.` with /s) keeps multi-line asks
 * whole without relying on the dotAll flag.
 */
const PRIVATE_PREFIX = /^\s*private(?:\s*:\s*|\s+)([\s\S]*)$/i;

/** `docs` on its own — `private docs about taxes` is a chat ask, not a listing. */
const DOCS_ONLY = /^docs\s*$/i;

/** `ingest <path>` — path is everything after the subcommand, spaces included. */
const INGEST_WITH_PATH = /^ingest\s+([\s\S]+)$/i;

/** Drop one matched pair of surrounding quotes so `"…/my notes.txt"` survives. */
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Classify one operator line.
 *
 * @returns `null` when the line is not a private command — the caller then
 * proceeds with its normal (hosted/local) routing. Any non-null result MUST be
 * handled entirely inside the private branch: no external network call.
 */
export function parsePrivateCommand(text: string): PrivateCommand | null {
  if (typeof text !== "string") return null;
  const m = text.match(PRIVATE_PREFIX);
  if (!m) return null;

  const rest = m[1].trim();
  if (!rest) return null; // bare `private` / `private:` — nothing to ask

  if (DOCS_ONLY.test(rest)) return { kind: "docs" };

  const ingest = rest.match(INGEST_WITH_PATH);
  if (ingest) {
    const path = unquote(ingest[1]);
    if (path) return { kind: "ingest", path };
  }

  return { kind: "chat", text: rest };
}
