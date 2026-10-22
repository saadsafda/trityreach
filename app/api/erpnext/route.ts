import { NextResponse } from "next/server";
import {
  clearErpConfig,
  normalizeErpUrl,
  readErpConfig,
  readErpStatus,
  testErpConnection,
  toPublicStatus,
  writeErpConfig,
} from "@/lib/erpnext";
import { appendActivityEvent, ensureDataDirectory } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ erpnext: await readErpStatus() }, { headers: { "Cache-Control": "no-store" } });
}

/** Connect, or update an existing connection. Key and secret may be left
 * blank to keep the saved ones (same site), so toggles can change without
 * re-pasting them. Credentials are always re-tested before being saved. */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const url = normalizeErpUrl(String(body.url ?? ""));
    let apiKey = String(body.apiKey ?? "").trim();
    let apiSecret = String(body.apiSecret ?? "").trim();
    const saved = await readErpConfig();

    if (!apiKey && saved && saved.url === url) apiKey = saved.apiKey;
    if (!apiKey) throw new Error("Enter the API key from your ERP user.");
    if (!apiSecret) {
      if (saved && saved.url === url && saved.apiKey === apiKey) apiSecret = saved.apiSecret;
      else throw new Error("Enter the API secret from your ERP user.");
    }

    const user = await testErpConnection({ url, apiKey, apiSecret });
    const config = {
      url,
      apiKey,
      apiSecret,
      saveLeads: body.saveLeads !== false,
      skipExisting: body.skipExisting !== false,
      user,
      connectedAt: saved?.url === url ? saved.connectedAt || new Date().toISOString() : new Date().toISOString(),
    };
    await ensureDataDirectory();
    await writeErpConfig(config);
    if (!saved || saved.url !== url) {
      await appendActivityEvent({
        id: crypto.randomUUID(),
        type: "erpnext",
        message: `Connected ERP at ${url}`,
        detail: `Signed in as ${user}`,
        createdAt: new Date().toISOString(),
      });
    }
    return NextResponse.json({ erpnext: toPublicStatus(config) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not connect to ERP";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE() {
  const saved = await readErpConfig();
  await clearErpConfig();
  if (saved) {
    await appendActivityEvent({
      id: crypto.randomUUID(),
      type: "erpnext",
      message: `Disconnected ERP at ${saved.url}`,
      createdAt: new Date().toISOString(),
    });
  }
  return NextResponse.json({ erpnext: toPublicStatus(null) });
}
