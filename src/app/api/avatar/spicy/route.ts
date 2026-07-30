import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

/**
 * SPICY MODE clips — auth-gated streaming from OUTSIDE the repo.
 *
 * The videos live in the avatar app's asset folder on this machine and must
 * never enter git or public/ (public/ is served ungated; these are private).
 * This route is covered by src/middleware.ts's default /api/* gate, so only a
 * logged-in deck can list or stream them.
 *
 *   GET /api/avatar/spicy            → { clips: ["spicy_mode.mp4", ...] }
 *   GET /api/avatar/spicy?clip=NAME  → the video bytes, with HTTP Range
 *                                      support (WKWebView/Safari refuse to
 *                                      play mp4 from a route without Range).
 *
 * NAME is matched against the directory's actual .mp4 listing — an allowlist
 * by construction, so traversal ("../", absolute paths, %2e tricks) cannot
 * reach anything else: whatever arrives either equals a listed basename or is
 * rejected.
 */

export const runtime = "nodejs";

const SPICY_DIR =
  process.env.STARRA_SPICY_DIR ||
  "/Users/work/Desktop/STARGATE/starra-avatar/assets/spicy";

async function listClips(): Promise<string[]> {
  try {
    const entries = await fs.readdir(SPICY_DIR);
    return entries.filter((f) => f.toLowerCase().endsWith(".mp4")).sort();
  } catch {
    return []; // folder missing/unreadable → empty list, never a throw
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const clip = url.searchParams.get("clip");
  const clips = await listClips();

  if (!clip) return Response.json({ clips });

  // Allowlist check: the request must name EXACTLY one of the listed files.
  if (!clips.includes(clip)) {
    return Response.json({ error: "unknown clip" }, { status: 404 });
  }
  const filePath = path.join(SPICY_DIR, clip);

  let size: number;
  try {
    const st = await fs.stat(filePath);
    size = st.size;
  } catch {
    return Response.json({ error: "clip unreadable" }, { status: 404 });
  }

  const common = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };

  const range = req.headers.get("range");
  if (range) {
    // "bytes=start-end" — the only form browsers send for <video>.
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : size - 1;
    if (!m || Number.isNaN(start) || Number.isNaN(end)) {
      start = 0;
      end = size - 1;
    }
    if (start >= size) {
      return new Response(null, {
        status: 416,
        headers: { ...common, "Content-Range": `bytes */${size}` },
      });
    }
    end = Math.min(end, size - 1);
    const stream = Readable.toWeb(
      createReadStream(filePath, { start, end }),
    ) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        ...common,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: { ...common, "Content-Length": String(size) },
  });
}
