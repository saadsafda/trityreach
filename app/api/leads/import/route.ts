import { NextResponse } from "next/server";
import { emailKey, existingMatch, fetchExistingIndex, phoneKey, readErpConfig, rememberLead } from "@/lib/erpnext";
import { validateLead } from "@/lib/lead-input";
import { appendActivityEvent, appendManualLeads, ensureDataDirectory, readSavedLeads } from "@/lib/storage";
import type { ImportSummary, Lead } from "@/lib/types";

export const runtime = "nodejs";

const MAX_IMPORT_ROWS = 5000;

/** POST { leads: [{...lead fields, _row}], skipErp } — leads already mapped
 * from the file's columns. Saves the valid, new ones as manual leads (never
 * overwritten by scrapes) and reports what was skipped and why. */
export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { leads?: unknown; skipErp?: unknown; fileName?: unknown };
    if (!Array.isArray(body.leads) || !body.leads.length) throw new Error("There are no rows to import.");
    if (body.leads.length > MAX_IMPORT_ROWS) throw new Error(`Import at most ${MAX_IMPORT_ROWS} rows at a time.`);

    // Email and phone are matched separately (phones by their digits), so the
    // same store written "(732) 555-0191" and "732-555-0191" is one lead.
    const crmEmails = new Set<string>();
    const crmPhones = new Set<string>();
    for (const lead of await readSavedLeads()) {
      if (emailKey(lead.email)) crmEmails.add(emailKey(lead.email));
      if (phoneKey(lead.phone)) crmPhones.add(phoneKey(lead.phone));
    }
    const fileEmails = new Set<string>();
    const filePhones = new Set<string>();
    const seenIn = (emails: Set<string>, phones: Set<string>, lead: Lead) =>
      (emailKey(lead.email) && emails.has(emailKey(lead.email))) || (phoneKey(lead.phone) && phones.has(phoneKey(lead.phone)));
    const config = body.skipErp === true ? await readErpConfig() : null;
    let erpIndex: Awaited<ReturnType<typeof fetchExistingIndex>> | null = null;
    let erpWarning = "";
    if (config) {
      try {
        erpIndex = await fetchExistingIndex(config);
      } catch (error) {
        // Import anyway; only the ERP duplicate check is skipped.
        erpWarning = `${error instanceof Error ? error.message : "Could not reach your ERP"} — imported without checking ERP for duplicates.`;
      }
    }

    const summary: ImportSummary = {
      imported: 0,
      duplicatesInFile: 0,
      alreadyInCrm: 0,
      alreadyInErp: 0,
      invalid: [],
      invalidCount: 0,
      ...(erpWarning ? { erpWarning } : {}),
    };
    const accepted: Lead[] = [];

    for (const [index, raw] of (body.leads as Record<string, unknown>[]).entries()) {
      const row = Number(raw?._row) || index + 2;
      const result = validateLead(raw ?? {});
      if ("error" in result) {
        summary.invalidCount += 1;
        if (summary.invalid.length < 50) {
          summary.invalid.push({ row, business: String(raw?.business_name ?? "").slice(0, 80), reason: result.error });
        }
        continue;
      }
      const { lead } = result;
      if (seenIn(fileEmails, filePhones, lead)) {
        summary.duplicatesInFile += 1;
        continue;
      }
      if (emailKey(lead.email)) fileEmails.add(emailKey(lead.email));
      if (phoneKey(lead.phone)) filePhones.add(phoneKey(lead.phone));
      if (seenIn(crmEmails, crmPhones, lead)) {
        summary.alreadyInCrm += 1;
        continue;
      }
      if (erpIndex && existingMatch(erpIndex, lead)) {
        summary.alreadyInErp += 1;
        continue;
      }
      if (erpIndex) rememberLead(erpIndex, lead);
      accepted.push(lead);
    }

    await ensureDataDirectory();
    await appendManualLeads(accepted);
    summary.imported = accepted.length;

    const fileName = typeof body.fileName === "string" ? body.fileName.slice(0, 120) : "a file";
    await appendActivityEvent({
      id: crypto.randomUUID(),
      type: "lead_found",
      message: `Imported ${summary.imported} lead(s) from ${fileName}`,
      detail: [
        summary.alreadyInCrm && `${summary.alreadyInCrm} already in CRM`,
        summary.alreadyInErp && `${summary.alreadyInErp} already in ERP`,
        summary.duplicatesInFile && `${summary.duplicatesInFile} duplicate rows`,
        summary.invalidCount && `${summary.invalidCount} invalid`,
      ]
        .filter(Boolean)
        .join(" · ") || "Uploaded on the CRM page",
      createdAt: new Date().toISOString(),
    });

    return NextResponse.json(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not import the leads";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
