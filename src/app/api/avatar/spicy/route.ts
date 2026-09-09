import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

/**
 * SPICY MODE clips — auth-gated streaming from OUTSIDE the repo.
 *
 * The videos live in the avatar app's asset folders on this machine and must
 * never enter git or public/ (public/ is served ungated; these are private).
 * This route is covered by src/middleware.ts's default /api/* gate, so only a
 * logged-in deck can list or stream them.
 *
 *   GET /api/avatar/spicy            → { clips: ["spicy_mode.mp4", ...] }
 *   GET /api/avatar/spicy?clip=NAME  → the video bytes, with HTTP Range
 *                                      support (WKWebView/Safari refuse to
 *                                      play mp4 from a route without Range).
 *
 * MULTIPLE DIRECTORIES (2026-08-22). Classic's spicy clips live in two places,
 * and this route could only ever see the first — 5 of 17 clips. It now scans a
 * LIST of directories and merges them into one flat namespace.
 *
 * THE SECURITY PROPERTY IS STRONGER THAN BEFORE, not weaker. The old code did
 * `path.join(SPICY_DIR, clip)` after an `includes()` check — safe, but it still
 * built a path out of caller-supplied text. Now the served path is the value
 * stored in the listing map, produced by readdir; the request string is only
 * ever used as a MAP KEY and never reaches the filesystem. Traversal ("../",
 * absolute paths, %2e tricks) cannot express a key that readdir emitted, so it
 * simply misses the map and 404s.
 *
 * First directory wins on a duplicate basename, so the order below is the
 * precedence order.
 */

export const runtime = "nodejs";

/**
 * Override with STARRA_SPICY_DIR. A single path still works exactly as before;
 * several are separated by the platform path delimiter (":" on macOS).
 */
const SPICY_DIRS: string[] = (
  process.env.STARRA_SPICY_DIR
    ? process.env.STARRA_SPICY_DIR.split(path.delimiter)
    : [
        path.join(os.homedir(), "STARGATE/starra-avatar/assets/spicy"),
        path.join(
          os.homedir(),
          "STARGATE/STARRA IS ALIVE!!!/STARRA MOVEMENTS/spicy mode",
        ),
      ]
)
  .map((d) => d.trim())
  .filter(Boolean);

/**
 * basename → absolute path, for every .mp4 across every configured directory.
 * A missing or unreadable directory is skipped, never thrown: one bad folder
 * must not take her whole spicy library offline.
 */
async function listClipMap(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const dir of SPICY_DIRS) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.toLowerCase().endsWith(".mp4")) continue;
      if (!found.has(name)) found.set(name, path.join(dir, name));
    }
  }
  return found;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const clip = url.searchParams.get("clip");
  const found = await listClipMap();

  if (!clip) return Response.json({ clips: [...found.keys()].sort() });

  // Allowlist by construction: the only paths that exist are ones readdir
  // produced. The request string is a map key and never touches the filesystem.
  const filePath = found.get(clip);
  if (!filePath) {
    return Response.json({ error: "unknown clip" }, { status: 404 });
  }

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
