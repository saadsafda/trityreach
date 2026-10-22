import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";

/** Every page and API route needs a login, except the login itself and the
 * webhooks n8n posts to (those check INBOUND_WEBHOOK_SECRET instead). */
const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/logout"]);
const INBOUND_WEBHOOKS = new Set(["/api/activity", "/api/conversations"]);

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const loggedIn = isValidSessionToken(request.cookies.get(SESSION_COOKIE)?.value);

  if (pathname === "/login" && loggedIn) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  if (PUBLIC_PATHS.has(pathname) || (request.method === "POST" && INBOUND_WEBHOOKS.has(pathname)) || loggedIn) {
    return NextResponse.next();
  }
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Log in to continue." }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  // Skip Next's own assets and files with an extension (icons, images).
  matcher: ["/((?!_next/static|_next/image|.*\\.[a-zA-Z0-9]+$).*)"],
};
