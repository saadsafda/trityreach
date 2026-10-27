import { NextResponse } from "next/server";
import { createErpLead, existingMatch, fetchExistingIndex, readErpConfig } from "@/lib/erpnext";
import { appendActivityEvent, removePendingErpLeads } from "@/lib/storage";
import { LEAD_FIELDS, type Lead } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sameLead(a: Lead, b: Lead): boolean {
  return LEAD_FIELDS.every((field) => (a[field] ?? "").trim() === (b[field] ?? "").trim());
}

/** POST { lead } → creates that one lead in ERPNext, unless ERPNext already
 * has it (same email, phone, website, or name in the same city).
 * Responds { status: "created", name, url } or { status: "exists", reason }. */
export async function POST(request: Request) {
  const config = await readErpConfig();
  if (!config) {
    return NextResponse.json({ error: "Connect ERP on the Integrations page first." }, { status: 400 });
  }

  let lead: Lead;
  try {
    const body = (await request.json()) as { lead?: Record<string, unknown> };
    const input = body.lead ?? {};
    lead = Object.fromEntries(
      LEAD_FIELDS.map((field) => [field, String(input[field] ?? "").replace(/\s+/g, " ").trim().slice(0, 300)]),
    ) as Lead;
  } catch {
    return NextResponse.json({ error: "Send the lead to save." }, { status: 400 });
  }
  if (!lead.business_name) {
    return NextResponse.json({ error: "This lead has no business name." }, { status: 400 });
  }

  try {
    const index = await fetchExistingIndex(config);
    const reason = existingMatch(index, lead);
    if (reason) {
      await removePendingErpLeads((other) => sameLead(other, lead));
      return NextResponse.json({ status: "exists", reason });
    }

    const name = await createErpLead(config, lead);
    await removePendingErpLeads((other) => sameLead(other, lead));
    await appendActivityEvent({
      id: crypto.randomUUID(),
      type: "erpnext",
      message: `Saved ${lead.business_name} to ERP${name ? ` as ${name}` : ""}`,
      detail: "Sent from its lead card",
      createdAt: new Date().toISOString(),
    });
    return NextResponse.json({
      status: "created",
      name,
      url: name ? `${config.url}/app/lead/${encodeURIComponent(name)}` : "",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not save to ERP";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
