import { NextResponse, type NextRequest } from "next/server";
import { authPassword, authCookieName, verifyToken } from "@/lib/auth";

// Paths that must stay reachable while logged OUT (the login screen + its API).
const PUBLIC_PREFIXES = ["/login", "/api/auth"];

export const config = {
  // Run on everything EXCEPT Next internals and static assets, so the login
  // page and brand assets always load even when the deck is gated.
  matcher: [
    "/((?!_next/|brand/|favicon|manifest|.*\\.(?:webp|png|jpg|jpeg|svg|ico|gif|webm|mp4|js|css|map|woff2?|ttf|json)$).*)",
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
