import { NextResponse } from "next/server";
import { leadKeyForClient } from "@/lib/lead-key";
import {
  appendActivityEvent,
  appendManualLead,
  ensureDataDirectory,
  readLeads,
} from "@/lib/storage";
import { LEAD_FIELDS, type Lead } from "@/lib/types";

export const runtime = "nodejs";

function normalizeLead(body: Record<string, unknown>): Lead {
  const lead = Object.fromEntries(
    LEAD_FIELDS.map((field) => [field, String(body[field] ?? "").trim().slice(0, 300)]),
  ) as Lead;

  if (!lead.business_name) {
    throw new Error("Business name is required.");
  }
  if (!lead.email && !lead.phone) {
    throw new Error("Add an email or a phone number so the lead can be contacted.");
  }
  if (lead.email && !/^\S+@\S+\.\S+$/.test(lead.email)) {
    throw new Error("The email address does not look valid.");
  }
  if (lead.phone && lead.phone.replace(/\D/g, "").length < 7) {
    throw new Error("The phone number does not look valid.");
  }
  if (lead.website && !/^https?:\/\//i.test(lead.website)) {
    lead.website = `https://${lead.website}`;
  }
  return lead;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const lead = normalizeLead(body);

    const existing = await readLeads();
    const key = leadKeyForClient(lead);
    if (existing.some((other) => leadKeyForClient(other) === key)) {
      return NextResponse.json(
        { error: "A lead with this email/phone already exists." },
        { status: 409 },
      );
    }

    await ensureDataDirectory();
    await appendManualLead(lead);
    await appendActivityEvent({
      id: crypto.randomUUID(),
      type: "lead_found",
      message: `Added lead manually: ${lead.business_name}`,
      detail: "Entered from the dashboard",
      createdAt: new Date().toISOString(),
    });

    return NextResponse.json({ lead }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not add the lead";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
