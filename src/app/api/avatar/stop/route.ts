import { NextResponse } from "next/server";
import { createRequire } from "node:module";

// child_process is loaded OPAQUELY on purpose — see tests/route-bundler-traps.test.ts.
// Turbopack statically traces the argument array of any spawn()/exec() call whose
// binding it can see and tries to resolve that string as a module, which 500s the
// route in dev (it took the whole /tools page down on 2026-08-08). createRequire
// returns a value the bundler cannot identify, so it stops tracing. Reverting this
// to a static import reintroduces the failure.
const nodeRequire = createRequire(import.meta.url);
const { exec } = nodeRequire("child_process") as typeof import("node:child_process");

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
