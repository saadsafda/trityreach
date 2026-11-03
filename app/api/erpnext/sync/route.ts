import { NextResponse } from "next/server";
import { createErpLead, existingMatch, fetchExistingIndex, readErpConfig, rememberLead } from "@/lib/erpnext";
import { appendActivityEvent, readSavedLeads, removePendingErpLeads } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pushes every lead in the CRM's database that isn't in ERPNext yet.
 * Safe to click repeatedly: anything already there is skipped. */
export async function POST() {
  const config = await readErpConfig();
  if (!config) {
    return NextResponse.json({ error: "Connect ERP on the Integrations page first." }, { status: 400 });
  }

  try {
    const [leads, index] = await Promise.all([readSavedLeads(), fetchExistingIndex(config)]);
    let created = 0;
    let skipped = 0;
    const failed: { business: string; error: string }[] = [];

    for (const lead of leads) {
      if (!lead.business_name.trim()) {
        skipped += 1;
        continue;
      }
      if (existingMatch(index, lead)) {
        skipped += 1;
        continue;
      }
      try {
        await createErpLead(config, lead);
        rememberLead(index, lead);
        created += 1;
      } catch (error) {
        failed.push({
          business: lead.business_name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Everything ERPNext now has stops waiting (rememberLead added the new ones).
    await removePendingErpLeads((lead) => Boolean(existingMatch(index, lead)));

    await appendActivityEvent({
      id: crypto.randomUUID(),
      type: "erpnext",
      message: `Synced to ERP: ${created} created, ${skipped} already there`,
      detail: failed.length
        ? `${failed.length} failed — ${failed.map((item) => `${item.business}: ${item.error}`).join("; ")}`
        : "Triggered manually from the CRM page",
      createdAt: new Date().toISOString(),
    });

    return NextResponse.json({ created, skipped, failed });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not sync with ERP";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
