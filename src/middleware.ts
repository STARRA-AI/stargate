import { NextResponse, type NextRequest } from "next/server";
import { authPassword, authCookieName, verifyToken } from "@/lib/auth";

// Paths that must stay reachable while logged OUT (the login screen + its API).
// /starra-ca.crt is the mkcert root CA's PUBLIC certificate — the phone must be
// able to download it BEFORE it can log in over trusted TLS (the private key
// never leaves ~/Library/Application Support/mkcert/).
// /api/mcp carries its OWN bearer-token auth (STARRA_MCP_TOKEN) and must be
// reachable by xAI's servers, which cannot hold Classic's session cookie. It
// fails CLOSED when that token is unset, so listing it here does not open it —
// it moves the lock from the cookie to the token. See src/app/api/mcp/route.ts.
const PUBLIC_PREFIXES = ["/login", "/api/auth", "/starra-ca.crt", "/api/mcp", "/api/voice-tools"];

export const config = {
  // NODEJS RUNTIME (stable since Next 15.5) ON PURPOSE — 2026-07-31: after a
  // .next cache rebuild, the EDGE sandbox came up with an empty process.env,
  // authPassword() returned undefined, and the no-password clause silently
  // OPENED the whole deck while login (nodejs runtime) kept working. Running
  // the middleware on nodejs gives it the same env the routes see.
  runtime: "nodejs",
  // Run on everything EXCEPT Next internals and static assets, so the login
  // page and brand assets always load even when the deck is gated.
  //
  // `json` was REMOVED from this exclusion list 2026-07-29. It meant every URL
  // ending in `.json` bypassed the auth gate entirely — a standing hole that a
  // review found. It was not exploitable at the time (data/engine.json lives
  // outside public/ and returned 404 on every traversal attempt tried), but it
  // would silently un-gate any future .json route.
  //
  // What this newly gates: public/avatar/visemes/{anchor,bank,bank2}.json, which
  // her face fetches at runtime. Verified safe — those fetches set no
  // `credentials: "omit"`, so same-origin requests carry the session cookie by
  // default and pass the gate for a logged-in deck. `manifest` and `favicon`
  // remain excluded by name above, so the PWA install path is untouched.
  matcher: [
    "/((?!_next/|brand/|favicon|manifest|.*\\.(?:webp|png|jpg|jpeg|svg|ico|gif|webm|mp4|mp3|wav|m4a|ogg|js|css|map|woff2?|ttf)$).*)",
  ],
};

/** Hardening headers on every authed response. CSP intentionally absent for
 *  now: the dev deck relies on inline styles/scripts Next injects, and a wrong
 *  CSP bricks the WKWebView dock app — documented in docs/PLATFORM.md. */
function withSecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "SAMEORIGIN");
  res.headers.set("Referrer-Policy", "no-referrer");
  // Camera stays OFF by policy (the eye cam is retired); mic is hers for calls.
  res.headers.set("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)");
  return res;
}

export async function middleware(req: NextRequest) {
  // FAIL CLOSED (2026-07-31). The old rule — gate off when no password is
  // configured — is exactly what turned an env-loading failure into a silently
  // open deck. The convenience survives ONLY for loopback (his own machine,
  // fresh setup); any non-local request with no password configured is refused.
  if (!authPassword()) {
    const host = (req.headers.get("host") ?? "").toLowerCase();
    const local =
      host.startsWith("localhost") ||
      host.startsWith("127.0.0.1") ||
      host.startsWith("[::1]");
    if (local) return NextResponse.next();
    return new NextResponse("STARGATE auth unavailable — deck sealed.", { status: 503 });
  }

  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(authCookieName())?.value;
  if (await verifyToken(token)) return withSecurityHeaders(NextResponse.next());

  // Not authenticated. APIs get a clean 401; pages redirect to the login screen.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
  return NextResponse.redirect(url);
}
