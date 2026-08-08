import { spawn } from "child_process";

/**
 * AGENT REACH — her hands on the open internet.
 *
 * Wraps the zero-config Agent Reach channels (installed 2026-08-06 at
 * ~/.local/bin/agent-reach) so she can read a page, pull a video's subtitles,
 * or take an RSS feed without leaving the deck.
 *
 * DELIBERATELY CREDENTIAL-FREE. Agent Reach also ships Twitter / Reddit /
 * Facebook / Instagram / XiaoHongShu / Xueqiu channels, and every one of them
 * wants a logged-in browser session. This machine holds Alpaca paper keys, the
 * Groq/xAI keys, the deck password and the mkcert CA — so those channels are
 * NOT wired here. Adding one is a deliberate act, not a default.
 *
 * SECURITY:
 *  - Every call is `spawn(cmd, argv)` with an argument ARRAY and no shell, the
 *    same shape repomix.ts uses. User text never becomes a shell string.
 *  - URLs are parsed with `new URL()` and must be http/https, so `file://`,
 *    `javascript:` and friends cannot get through.
 *  - Output is truncated, and the CALLER fences it with fenceUntrusted(). Every
 *    byte here is attacker-controlled content off the open web — it is data,
 *    never instructions.
 */

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 6000;

export type ReachResult = { ok: boolean; text: string };

/** http/https only. Returns null for anything else, including junk. */
export function safeUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function run(cmd: string, args: string[]): Promise<ReachResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    const finish = (r: ReachResult) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    // A binary missing from PATH emits 'error', not a non-zero exit. Without
    // this listener that rejects the promise and 500s the route (repomix.ts:23).
    const child = spawn(cmd, args, { env: process.env });
    child.on("error", (e) => finish({ ok: false, text: `${cmd} unavailable — ${e.message}` }));
    child.stdout?.on("data", (d) => {
      out += String(d);
    });
    child.stderr?.on("data", (d) => {
      err += String(d);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, text: `${cmd} timed out after ${TIMEOUT_MS / 1000}s` });
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      const body = (out || err).slice(0, MAX_OUTPUT);
      finish(
        code === 0
          ? { ok: true, text: body }
          : { ok: false, text: body || `exited ${code}` },
      );
    });
  });
}

/**
 * Read any page as clean markdown via Jina Reader.
 *
 * MEASURED 2026-08-06: the anonymous endpoint returns 401 on Classic's network
 * — "blocked from performing anonymous queries due to bad network reputation
 * (AS7018)", i.e. his AT&T range is flagged. `agent-reach doctor` reports this
 * channel as available because it checks config, not a live call. So we send
 * JINA_API_KEY when it exists and give a straight answer when it doesn't,
 * instead of surfacing a raw 401 as if the page were empty.
 */
export async function reachRead(url: string): Promise<ReachResult> {
  const safe = safeUrl(url);
  if (!safe) return { ok: false, text: "That isn't a readable http(s) URL." };
  const key = process.env.JINA_API_KEY;
  const args = ["-sS", "-m", "25"];
  if (key) args.push("-H", `Authorization: Bearer ${key}`);
  args.push(`https://r.jina.ai/${safe}`);
  const r = await run("curl", args);
  if (r.ok && /AuthenticationRequiredError|bad network reputation/.test(r.text)) {
    return {
      ok: false,
      text: "Jina Reader refused an anonymous read from this network (AT&T range is flagged). A free key from jina.ai in JINA_API_KEY fixes it permanently.",
    };
  }
  return r;
}

/**
 * Video title/uploader/duration/description via yt-dlp — YouTube plus 1800+
 * other sites.
 *
 * Uses `--print`, NOT `--dump-json`. Learned the hard way 2026-08-06: a full
 * --dump-json payload for one video runs well past MAX_OUTPUT, so truncation
 * sliced the JSON mid-object and every parse threw, silently dumping raw JSON
 * at her instead of a summary. Asking yt-dlp for the four fields we actually
 * want means there is no giant blob to truncate and nothing to parse.
 */
export async function reachVideo(url: string): Promise<ReachResult> {
  const safe = safeUrl(url);
  if (!safe) return { ok: false, text: "That isn't a video URL I can reach." };
  const r = await run("yt-dlp", [
    "--skip-download",
    "--no-warnings",
    "--print",
    "title: %(title)s",
    "--print",
    "by: %(uploader)s",
    "--print",
    "duration: %(duration)ss",
    "--print",
    "%(description).1500s",
    safe,
  ]);
  return r.ok ? { ok: true, text: r.text.trim() } : r;
}

/** RSS/Atom via agent-reach's own channel. */
export async function reachFeed(url: string): Promise<ReachResult> {
  const safe = safeUrl(url);
  if (!safe) return { ok: false, text: "That isn't a feed URL." };
  return run("agent-reach", ["rss", safe]);
}

export type ReachCommand =
  | { kind: "read"; url: string }
  | { kind: "video"; url: string }
  | { kind: "feed"; url: string }
  | { kind: "status" };

/**
 * Explicit operator commands only — free-form intent stays with the LLM, the
 * same contract every other fast-path in fastpath.ts honors.
 *   reach read <url> · reach video <url> · reach feed <url> · reach status
 */
export function parseReachCommand(message: string): ReachCommand | null {
  const m = /^\s*reach\s+(read|video|watch|feed|rss|status)\b\s*(\S+)?/i.exec(message || "");
  if (!m) return null;
  const verb = m[1].toLowerCase();
  const arg = m[2] ?? "";
  if (verb === "status") return { kind: "status" };
  if (!arg) return null;
  if (verb === "read") return { kind: "read", url: arg };
  if (verb === "video" || verb === "watch") return { kind: "video", url: arg };
  return { kind: "feed", url: arg };
}

/** `reach status` — which channels actually answer, straight from doctor. */
export async function reachStatus(): Promise<ReachResult> {
  const r = await run("agent-reach", ["doctor"]);
  return r.ok ? r : { ok: false, text: `agent-reach not reachable — ${r.text}` };
}
