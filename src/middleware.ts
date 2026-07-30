import { NextResponse, type NextRequest } from "next/server";
import { authPassword, authCookieName, verifyToken } from "@/lib/auth";

// Paths that must stay reachable while logged OUT (the login screen + its API).
const PUBLIC_PREFIXES = ["/login", "/api/auth"];

export const config = {
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

export async function middleware(req: NextRequest) {
  // Gate is OFF until a password is configured — never lock the deck with no key.
  if (!authPassword()) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(authCookieName())?.value;
  if (await verifyToken(token)) return NextResponse.next();

  // Not authenticated. APIs get a clean 401; pages redirect to the login screen.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = pathname && pathname !== "/" ? `?next=${encodeURIComponent(pathname)}` : "";
  return NextResponse.redirect(url);
}
