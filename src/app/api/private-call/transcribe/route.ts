/**
 * LOCAL EARS — the deck's own loopback door to whisper.cpp.
 *
 * WHY THIS ROUTE EXISTS AT ALL, since the browser could in principle POST the
 * WAV to 127.0.0.1:8178 itself:
 *
 *   1. WHISPER_BASE is a SERVER value (.env.local, written by P2 Task 2). A
 *      browser cannot read it. Reaching whisper from the tab would mean minting
 *      a NEXT_PUBLIC_ twin of the one setting whose whole job is to name the
 *      privacy boundary — i.e. baking it into a client bundle and inviting an
 *      operator to point it somewhere else. It stays server-side.
 *   2. The deck serves HTTPS. A cross-origin request from that page to a plain
 *      http:// loopback port drags in two browser policies (mixed content and
 *      Private Network Access) whose current behaviour differs by Chrome
 *      version and by which address the deck is opened on. Same-origin has no
 *      such question to answer, on the Mac or from the phone.
 *   3. It makes the privacy claim PROVABLE the way the brief asks for it: with
 *      both legs server-side, `lsof` against the dev-server pid shows every
 *      socket a private turn opens. A request made inside the tab is invisible
 *      to that proof.
 *
 * THE CONTRACT: this route talks to exactly ONE host, and refuses to start if
 * that host is not a numeric loopback address. There is no fallback — not a
 * hosted STT, not a different port, nothing. A private turn that cannot be
 * transcribed on this machine is not transcribed at all. That is the same
 * shape, and the same reasoning, as the private chat lane
 * (src/app/api/chat/route.ts:255-291).
 */
// ONE definition of "is this address really on this machine" — the private
// lane's, imported rather than re-typed. A second copy of a security predicate
// is a second copy that can drift; tests/private-lane.test.ts already pins this
// one against a table of hostile inputs (numeric-only: "localhost" is REFUSED,
// because a name is something a hosts file can move off-box).
import { isLoopbackBase } from "@/app/api/chat/route";

export const runtime = "nodejs";
/** A cold whisper model load plus a long utterance; the service is local, but
 * this machine is a 2-core Intel Mac and the first request pays for the load. */
export const maxDuration = 120;

/**
 * Where the ears listen when .env.local says nothing. This is not a guess: it
 * is the address scripts/whisper-up.sh HARDCODES for the server's bind
 * (`--host 127.0.0.1 --port 8178`), deliberately with no env override, "this is
 * the privacy boundary, not a tunable". Defaulting to the same literal means a
 * missing WHISPER_BASE degrades to the safe address rather than to nothing.
 */
export const WHISPER_FALLBACK_BASE = "http://127.0.0.1:8178";

/** whisper.cpp's own reader is 16 kHz mono 16-bit WAV
 * (vendor/whisper.cpp/examples/common-whisper.cpp:96,167). 30 s of that plus a
 * generous header allowance is the largest turn this route will forward — a
 * cap, so a stuck client cannot stream unbounded audio into a synchronous
 * transcription. */
export const MAX_WAV_BYTES = 30 * 16_000 * 2 + 4_096;

/** The smallest thing that can still be a WAV: a 44-byte header and a sample. */
const MIN_WAV_BYTES = 46;

export const WHISPER_DOWN_LINE =
  "Local ears are down. Run: scripts/whisper-up.sh";

function whisperBase(): string {
  const raw = (process.env.WHISPER_BASE ?? "").trim();
  return raw || WHISPER_FALLBACK_BASE;
}

/** Never cached, never stored. */
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function POST(req: Request): Promise<Response> {
  const base = whisperBase();
  if (!isLoopbackBase(base)) {
    return Response.json(
      {
        error: `Local ears refused to start: WHISPER_BASE must be a numeric loopback address (127.0.0.1 or ::1) — host names, "localhost" included, are refused. Got "${base}".`,
      },
      { status: 500, headers: NO_STORE },
    );
  }

  // Kept as the raw ArrayBuffer, not a Uint8Array view: a view's `buffer` is
  // ArrayBufferLike (it could be a SharedArrayBuffer), which is not a legal
  // BlobPart. The buffer itself is exactly what Blob wants.
  let bytes: ArrayBuffer;
  try {
    bytes = await req.arrayBuffer();
  } catch {
    return Response.json(
      { error: "unreadable audio body" },
      { status: 400, headers: NO_STORE },
    );
  }
  if (bytes.byteLength < MIN_WAV_BYTES) {
    return Response.json(
      { error: "audio body too short to be a WAV" },
      { status: 400, headers: NO_STORE },
    );
  }
  if (bytes.byteLength > MAX_WAV_BYTES) {
    return Response.json(
      { error: "utterance over the 30s local-transcription cap" },
      { status: 413, headers: NO_STORE },
    );
  }

  // The vendor's /inference wants multipart with a required `file` field, and
  // 400s with {"error":"no 'file' field in the request"} without it
  // (vendor/whisper.cpp/examples/server/server.cpp:817,822-830). Default
  // response_format "json" answers {"text": "…"} and nothing else
  // (server.cpp:1153-1161) — the smallest surface that carries what we need.
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), "turn.wav");
  form.append("response_format", "json");

  let res: Response;
  try {
    res = await fetch(`${base}/inference`, {
      method: "POST",
      body: form,
      signal: req.signal,
    });
  } catch (err) {
    if (req.signal.aborted) {
      // Operator hung up mid-turn. Nothing to explain to a socket that is gone.
      return Response.json({ text: "" }, { status: 200, headers: NO_STORE });
    }
    const msg = err instanceof Error ? err.message : String(err);
    const down =
      /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|fetch failed|socket hang up/i.test(
        msg,
      );
    // NO HOSTED FALLBACK, EVER — the audio stays on this machine even when the
    // service is down. Same rule as the private chat lane (route.ts:686-699).
    return Response.json(
      { error: down ? WHISPER_DOWN_LINE : `Local ears error: ${msg}` },
      { status: 503, headers: NO_STORE },
    );
  }

  if (!res.ok) {
    return Response.json(
      { error: `Local ears returned HTTP ${res.status}` },
      { status: 502, headers: NO_STORE },
    );
  }

  let text = "";
  try {
    const parsed: unknown = await res.json();
    const record =
      parsed !== null && typeof parsed === "object"
        ? (parsed as { text?: unknown })
        : null;
    if (typeof record?.text === "string") text = record.text;
  } catch {
    return Response.json(
      { error: "Local ears returned a body that was not JSON" },
      { status: 502, headers: NO_STORE },
    );
  }

  // whisper.cpp's segment joiner leaves leading spaces and newlines between
  // segments (proved on the wire in .superpowers/sdd/p2-task-2-report.md §6:
  // `{"text":" This is a local test…\n running on…\n"}`). Normalise here so
  // every caller sees one clean line instead of each writing its own trimmer.
  const clean = text.replace(/\s+/g, " ").trim();

  // NOTHING IS RECORDED. No feed line with the words in it, no memory write,
  // no log of the transcript — the private lane's "writes nothing to the shared
  // store" rule covers what he SAYS as much as what she answers.
  return Response.json({ text: clean }, { status: 200, headers: NO_STORE });
}
