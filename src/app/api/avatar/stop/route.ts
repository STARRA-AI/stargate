import { NextResponse } from "next/server";
import { exec } from "child_process";

export const runtime = "nodejs";

/**
 * Hang up — stop the STARRA talking-avatar desktop app (her face window).
 * Localhost only, same as launch. Kills the python main.py process.
 */
export async function POST(req: Request) {
  const host = (req.headers.get("host") || "").toLowerCase();
  const isLocal =
    host === "" ||
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1") ||
    host.startsWith("[::1]") ||
    host.startsWith("::1");
  if (!isLocal) {
    return NextResponse.json(
      { ok: false, error: "Her avatar is controlled only from this Mac (localhost)." },
      { status: 403 },
    );
  }

  return new Promise<Response>((resolve) => {
    // Kill her however she was launched: full-path python, the .app's relative
    // `python3 main.py`, and the STARRA-Avatar.app wrapper shell.
    exec(
      "pkill -f 'starra-avatar/main.py'; pkill -f 'python3 main.py'; pkill -f 'STARRA-Avatar.app'",
      () => resolve(NextResponse.json({ ok: true })),
    );
  });
}
