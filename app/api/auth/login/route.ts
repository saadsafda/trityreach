import { NextResponse } from "next/server";
import { SESSION_COOKIE, SESSION_MAX_AGE_S, checkCredentials, createSessionToken, isLoginConfigured } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Failed attempts per client, to slow down password guessing. */
const MAX_FAILURES = 8;
const LOCKOUT_MS = 15 * 60 * 1000;
const failuresState = globalThis as typeof globalThis & {
  __trityLoginFailures?: Map<string, { count: number; until: number }>;
};
const failures = (failuresState.__trityLoginFailures ??= new Map());

function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

/** POST { username, password } → sets the session cookie. */
export async function POST(request: Request) {
  if (!isLoginConfigured()) {
    return NextResponse.json(
      { error: "Login isn't set up — add AUTH_USERNAME and AUTH_PASSWORD to .env and restart the app." },
      { status: 503 },
    );
  }
  const key = clientKey(request);
  const record = failures.get(key);
  if (record && record.count >= MAX_FAILURES && record.until > Date.now()) {
    const minutes = Math.ceil((record.until - Date.now()) / 60_000);
    return NextResponse.json(
      { error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` },
      { status: 429 },
    );
  }

  let body: { username?: unknown; password?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Enter your username and password." }, { status: 400 });
  }
  if (!checkCredentials(String(body.username ?? ""), String(body.password ?? ""))) {
    const count = record && record.until > Date.now() ? record.count + 1 : 1;
    failures.set(key, { count, until: Date.now() + LOCKOUT_MS });
    return NextResponse.json({ error: "Wrong username or password." }, { status: 401 });
  }

  failures.delete(key);
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, createSessionToken(), {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(request.url).protocol === "https:",
    path: "/",
    maxAge: SESSION_MAX_AGE_S,
  });
  return response;
}
