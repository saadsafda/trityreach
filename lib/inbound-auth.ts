/** Verifies the shared-secret bearer token sent by n8n / the scraper on
 * inbound webhook calls. Returns true when no secret is configured, so local
 * development keeps working without setup. */
export function isAuthorizedInboundRequest(request: Request): boolean {
  const secret = process.env.INBOUND_WEBHOOK_SECRET?.trim();
  if (!secret) return true;
  const header = request.headers.get("authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  return token === secret;
}
