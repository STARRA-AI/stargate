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
    // Kill her however she was launched: the raw python3 fallback spawn (always
    // invoked with the script's full path, so it always contains
    // "starra-avatar/main.py") and the STARRA-Avatar.app wrapper shell. (A bare
    // 'python3 main.py' pattern was removed here: launch/route.ts always passes
    // main.py's absolute path as the argv, so that pattern never matched the
    // avatar process — it could only ever have matched an unrelated python
    // process elsewhere on the machine.)
    exec(
      "pkill -f 'starra-avatar/main.py'; pkill -f 'STARRA-Avatar.app'",
      () => resolve(NextResponse.json({ ok: true })),
    );
  });
}
