import { NextResponse } from "next/server";
import { fetchErpLeadsForMap, readErpConfig } from "@/lib/erpnext";
import { saveLeads } from "@/lib/lead-db";
import { appendActivityEvent } from "@/lib/storage";
import { LEAD_FIELDS, type Lead } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Copies every ERPNext Lead into the CRM's own database. Only reads from
 * ERPNext, and is safe to repeat: leads already saved just get their blanks
 * filled. Responds { total, added, updated }. */
export async function POST() {
  const config = await readErpConfig();
  if (!config) {
    return NextResponse.json({ error: "Connect ERP on the Integrations page first." }, { status: 400 });
  }
  try {
    const records = await fetchErpLeadsForMap(config);
    const leads = records.map((record) => ({
      ...(Object.fromEntries(LEAD_FIELDS.map((field) => [field, record[field] ?? ""])) as Lead),
      createdAt: record.createdAt,
    }));
    const { added, updated } = saveLeads(leads, "erp");
    await appendActivityEvent({
      id: crypto.randomUUID(),
      type: "erpnext",
      message: `Imported ${added} new lead(s) from ERP into the CRM`,
      detail: `${records.length} read from ${config.url}; ${updated} already saved got missing details filled`,
      createdAt: new Date().toISOString(),
    });
    return NextResponse.json({ total: records.length, added, updated });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read leads from ERP";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
