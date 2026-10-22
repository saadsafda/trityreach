import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** Single-user login: the username and password live in .env
 * (AUTH_USERNAME / AUTH_PASSWORD). A signed cookie keeps the browser logged
 * in; it is keyed on the password, so changing the password in .env logs
 * every browser out. */

export const SESSION_COOKIE = "trity_session";
export const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

type Credentials = { username: string; password: string };

function configuredCredentials(): Credentials | null {
  const username = process.env.AUTH_USERNAME?.trim() ?? "";
  const password = process.env.AUTH_PASSWORD ?? "";
  return username && password ? { username, password } : null;
}

export function isLoginConfigured(): boolean {
  return configuredCredentials() !== null;
}

function sameText(a: string, b: string): boolean {
  // Compare digests so the check takes the same time whatever the lengths.
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function checkCredentials(username: string, password: string): boolean {
  const expected = configuredCredentials();
  if (!expected) return false;
  // Evaluate both so a wrong username isn't faster than a wrong password.
  const userOk = sameText(username.trim().toLowerCase(), expected.username.toLowerCase());
  const passwordOk = sameText(password, expected.password);
  return userOk && passwordOk;
}

function signingKey(credentials: Credentials): string {
  return `${process.env.AUTH_SECRET ?? ""}|${credentials.username}|${credentials.password}`;
}

function sign(payload: string, credentials: Credentials): string {
  return createHmac("sha256", signingKey(credentials)).update(payload).digest("base64url");
}

/** "<expires-at-ms>.<signature>" */
export function createSessionToken(): string {
  const credentials = configuredCredentials();
  if (!credentials) throw new Error("Login isn't set up.");
  const payload = String(Date.now() + SESSION_MAX_AGE_S * 1000);
  return `${payload}.${sign(payload, credentials)}`;
}

export function isValidSessionToken(token: string | undefined): boolean {
  const credentials = configuredCredentials();
  if (!credentials || !token) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !/^\d+$/.test(payload) || Number(payload) < Date.now()) return false;
  return sameText(signature, sign(payload, credentials));
}
